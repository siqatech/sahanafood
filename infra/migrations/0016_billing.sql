-- 0016 — Facturación electrónica: series, correlativos y documentos
-- (spec 10, T4.26/T4.27, ADR-0003).
--
-- REVISAR SIEMPRE ESTE DIFF: esto es lo que se declara a SUNAT. Un error aquí
-- no produce un bug, produce una infracción tributaria del cliente — y el
-- cliente es quien responde, no nosotros.
--
-- Cuatro decisiones que definen la forma:
--
-- 1. **El correlativo se toma AL EMITIR, no al encolar** (RN-BIL-01). Un
--    documento nace sin número. El número se asigna en una transacción que
--    bloquea la fila de la serie, y una vez asignado ES DE ESE DOCUMENTO PARA
--    SIEMPRE: los reintentos reenvían el mismo número. Cualquier otra cosa deja
--    huecos, y un hueco en la numeración hay que justificarlo ante SUNAT con
--    una comunicación de baja.
--
-- 2. **`documents` es la cola** (ADR-0003). No hay una tabla aparte de
--    pendientes: el estado del documento ES su posición en la cola. Dos tablas
--    que representan lo mismo se desincronizan, y aquí desincronizarse
--    significa una venta cobrada sin comprobante o un comprobante emitido dos
--    veces.
--
-- 3. **La fecha de emisión es la de la VENTA, no la del envío** (RN-BIL-03).
--    Una venta sin internet se cobra igual y su comprobante espera. El plazo
--    de SUNAT corre desde que se cobró; contarlo desde el envío haría que un
--    documento con tres días de retraso pareciera recién nacido.
--
-- 4. **Un documento rechazado NUNCA se borra** (RN-BIL-02). Pasa a
--    `rejected` con el motivo del OSE y espera corrección. Borrarlo perdería
--    la venta, que es lo único que no puede pasar.

-- ---------------------------------------------------------------------------
-- Series. Una por (empresa, tipo de documento).
--
-- El correlativo vive AQUÍ y no como un `max(+1)` sobre los documentos: contar
-- documentos para saber el siguiente número es una condición de carrera con
-- dos cajas cobrando a la vez, y el resultado es el mismo número en dos
-- comprobantes. Con una fila propia se puede bloquear.
-- ---------------------------------------------------------------------------
CREATE TABLE bil_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  company_id  uuid NOT NULL,

  -- F001, B001... La letra la impone el tipo (catálogo de SUNAT).
  series      text NOT NULL,
  doc_type    text NOT NULL,
  CONSTRAINT tipo_documento_valido
    CHECK (doc_type IN ('boleta','factura','nota_credito')),
  CONSTRAINT serie_con_formato CHECK (series ~ '^[FB][A-Z0-9]{3}$'),
  CONSTRAINT serie_concuerda_con_tipo CHECK (
    (doc_type = 'factura' AND series LIKE 'F%') OR
    (doc_type = 'boleta'  AND series LIKE 'B%') OR
    -- La nota de crédito hereda la letra del documento que corrige.
    (doc_type = 'nota_credito')
  ),

  -- Último correlativo ENTREGADO. El siguiente documento se lleva este + 1.
  last_correlative integer NOT NULL DEFAULT 0,
  CONSTRAINT correlativo_no_negativo CHECK (last_correlative >= 0),

  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, company_id, series),
  FOREIGN KEY (tenant_id, company_id)
    REFERENCES org_companies (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE bil_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE bil_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bil_series
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Una sola serie ACTIVA por (empresa, tipo): con dos, el sistema elegiría una
-- en silencio y la numeración quedaría repartida entre ambas sin que nadie lo
-- decidiera.
CREATE UNIQUE INDEX idx_bil_series_activa
  ON bil_series (tenant_id, company_id, doc_type)
  WHERE is_active;

-- ---------------------------------------------------------------------------
-- Documentos. Es también LA COLA de envío.
-- ---------------------------------------------------------------------------
CREATE TABLE bil_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  company_id  uuid NOT NULL,
  order_id    uuid,

  doc_type    text NOT NULL,
  CONSTRAINT tipo_documento_valido
    CHECK (doc_type IN ('boleta','factura','nota_credito')),

  -- NULL hasta que se asigna (RN-BIL-01: el correlativo se toma al emitir).
  series_id   uuid,
  series      text,
  correlative integer,
  -- Precalculado en el formato que espera SUNAT y lee el cliente: «B001-00000042».
  number      text,
  CONSTRAINT correlativo_positivo CHECK (correlative IS NULL OR correlative > 0),

  status      text NOT NULL DEFAULT 'queued',
  CONSTRAINT estado_valido CHECK (status IN (
    -- Nace sin número, esperando turno.
    'queued',
    -- Número asignado; pendiente de que el OSE lo acepte.
    'numbered',
    -- Aceptado por el OSE. Estado final feliz.
    'accepted',
    -- Rechazado: espera corrección. NUNCA se borra (RN-BIL-02).
    'rejected',
    -- Anulado por nota de crédito.
    'voided'
  )),

  -- Receptor. Denormalizado igual que en `ord_orders`: el comprobante tiene que
  -- poder leerse aunque el cliente ejerza su derecho al olvido.
  customer_doc_type text NOT NULL DEFAULT 'NONE',
  CONSTRAINT tipo_doc_cliente_valido
    CHECK (customer_doc_type IN ('DNI','RUC','CE','PASAPORTE','NONE')),
  customer_doc_number text,
  customer_name       text,
  -- Una factura SIEMPRE lleva RUC y razón social. Sin esto cabría una factura
  -- a nombre de nadie, que el OSE rechaza con la venta ya cobrada.
  CONSTRAINT factura_con_receptor CHECK (
    doc_type <> 'factura' OR
    (customer_doc_type = 'RUC' AND customer_doc_number IS NOT NULL
     AND customer_name IS NOT NULL)
  ),

  -- Importes: salida de @sahana/domain, jamás recalculados en SQL.
  subtotal     NUMERIC(14,4) NOT NULL,
  taxable_base NUMERIC(14,4) NOT NULL,
  tax          NUMERIC(14,4) NOT NULL,
  total        NUMERIC(14,4) NOT NULL,
  currency     text NOT NULL DEFAULT 'PEN',
  tax_rate_bps integer NOT NULL DEFAULT 1800,

  -- Copia de las líneas en el momento de emitir. Un comprobante NO puede
  -- reconstruirse desde el pedido: el pedido se modifica (RN-ORD-07) y el
  -- comprobante ya está declarado.
  lines        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Fecha de emisión REAL: cuando se cobró, no cuando se logró enviar
  -- (RN-BIL-03). Es contra esta que corre el plazo de SUNAT.
  issued_at    timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  accepted_at  timestamptz,

  -- Respuesta del OSE. Se guarda entera: cuando SUNAT pregunte, la respuesta
  -- es el documento, no nuestro resumen de él.
  provider          text,
  provider_ticket   text,
  provider_response jsonb,
  rejection_code    text,
  rejection_reason  text,

  -- Nota de crédito → documento que corrige.
  references_id uuid,

  attempts    integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)
    REFERENCES org_companies (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, series_id)
    REFERENCES bil_series (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, references_id)
    REFERENCES bil_documents (tenant_id, id) ON DELETE RESTRICT,

  -- El número y sus partes van juntos o no van. Un documento «numerado» sin
  -- número es un comprobante que nadie puede localizar.
  CONSTRAINT numero_completo_o_ausente CHECK (
    (series_id IS NULL AND series IS NULL AND correlative IS NULL AND number IS NULL) OR
    (series_id IS NOT NULL AND series IS NOT NULL AND correlative IS NOT NULL AND number IS NOT NULL)
  ),
  -- Todo lo que salió del estado inicial tiene número.
  CONSTRAINT emitido_tiene_numero CHECK (
    status = 'queued' OR number IS NOT NULL
  ),
  -- Un rechazo sin motivo no se puede corregir: quien lo mire no sabrá qué
  -- arreglar, y el documento se quedará en la cola para siempre.
  CONSTRAINT rechazo_con_motivo CHECK (
    status <> 'rejected' OR rejection_reason IS NOT NULL
  ),
  -- Una nota de crédito sin el documento que corrige no anula nada.
  CONSTRAINT nota_credito_referencia CHECK (
    doc_type <> 'nota_credito' OR references_id IS NOT NULL
  )
);

ALTER TABLE bil_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE bil_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bil_documents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- LA garantía de que no hay correlativos repetidos. No la da el código, la da
-- el motor: con dos cajas cobrando a la vez, el `FOR UPDATE` sobre la serie
-- serializa, y si algún día alguien escribe un camino que se lo salta, esto lo
-- para en seco.
CREATE UNIQUE INDEX idx_bil_documents_numero
  ON bil_documents (tenant_id, series_id, correlative)
  WHERE correlative IS NOT NULL;

-- Un pedido tiene UN comprobante (las notas de crédito son documentos aparte,
-- vinculados por `references_id`). Sin esto, un reintento del emisor podría
-- facturar dos veces la misma venta.
CREATE UNIQUE INDEX idx_bil_documents_pedido
  ON bil_documents (tenant_id, order_id)
  WHERE order_id IS NOT NULL AND doc_type <> 'nota_credito';

-- La cola de envío: lo pendiente, lo más antiguo primero (RN-BIL-03).
CREATE INDEX idx_bil_documents_cola
  ON bil_documents (tenant_id, status, issued_at)
  WHERE status IN ('queued','numbered','rejected');

CREATE INDEX idx_bil_documents_busqueda
  ON bil_documents (tenant_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- Bitácora de intentos contra el OSE. APPEND-ONLY.
--
-- Existe porque «el documento está rechazado» no basta para discutir con un
-- proveedor: hace falta qué se mandó, qué contestó y cuándo. Es la diferencia
-- entre reclamar con datos y reclamar de memoria.
-- ---------------------------------------------------------------------------
CREATE TABLE bil_submissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,

  attempt     integer NOT NULL,
  outcome     text NOT NULL,
  CONSTRAINT resultado_valido
    CHECK (outcome IN ('accepted','rejected','error')),

  provider    text NOT NULL,
  request     jsonb,
  response    jsonb,
  error_message text,
  latency_ms  integer,
  trace_id    text,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES bil_documents (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE bil_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bil_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bil_submissions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_bil_submissions_documento
  ON bil_submissions (tenant_id, document_id, occurred_at);

REVOKE UPDATE, DELETE ON bil_submissions FROM sahana_app;
