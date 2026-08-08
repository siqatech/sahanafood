-- 0028 — Plataforma de IA (spec 19, ADR-0011, T5.22–T5.32).
--
-- La regla que gobierna el módulo entero, de ADR-0011: **apagar la IA deja el
-- sistema 100 % funcional**. Nada de aquí es requisito de nada de fuera: sin
-- una sola fila en estas tablas, el negocio vende, cobra, cocina y reparte.
-- Por eso el agente vive en su propio esquema lógico y consume la bandeja
-- (spec 18) en vez de que la bandeja lo consuma a él.

-- pgvector lo instala `infra/docker/init/02-extensions.sql` con el
-- SUPERUSUARIO, no esta migración: `CREATE EXTENSION` exige superusuario y
-- `sahana_migrator` no lo es a propósito —es lo que impide que las migraciones
-- se salten RLS—. Aquí solo se comprueba que está, para fallar con un mensaje
-- que diga qué hacer en vez de con «type vector does not exist» treinta líneas
-- más abajo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'Falta la extensión pgvector. Ejecuta infra/docker/init/02-extensions.sql como superusuario (el compose lo hace solo al crear el volumen).';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- CONFIGURACIÓN DEL AGENTE, versionada (spec 19 §2.8, RN-AIA-04).
--
-- Publicar es crear una VERSIÓN INMUTABLE, no editar la vigente. Dos motivos:
--  · **Rollback en un clic**: volver a la anterior es apuntar a otra fila.
--  · **RN-AIA-04**: la config publicada aplica a chats NUEVOS; los activos
--    terminan con la suya. Sin versiones inmutables, cambiar el tono a mitad de
--    una conversación haría que el agente cambiara de personalidad en medio.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_agent_configs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,

  -- Número de versión creciente por marca. La versión 0 es el borrador.
  version       integer NOT NULL,
  status        text NOT NULL DEFAULT 'draft',
  CONSTRAINT estado_config_valido CHECK (status IN ('draft','published','archived')),

  -- Identidad y pautas (spec 19 §2.1 y §2.2). JSONB porque es configuración de
  -- texto libre del dueño y su forma cambiará; lo que NO va en JSONB es nada
  -- que decida dinero o acceso.
  identity      jsonb NOT NULL DEFAULT '{}',
  guidelines    jsonb NOT NULL DEFAULT '[]',
  limits        jsonb NOT NULL DEFAULT '{}',

  enabled       boolean NOT NULL DEFAULT false,

  published_at  timestamptz,
  published_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT publicada_tiene_fecha
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);

ALTER TABLE ai_agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_agent_configs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX idx_ai_configs_version
  ON ai_agent_configs (tenant_id, brand_id, version);

-- UNA sola publicada por marca. Dos serían dos agentes contestando distinto al
-- mismo cliente según qué fila leyera primero la consulta.
CREATE UNIQUE INDEX idx_ai_configs_publicada
  ON ai_agent_configs (tenant_id, brand_id)
  WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- ACCIONES DETERMINISTAS (spec 19 §2.3, T5.25).
--
-- Ganan SIEMPRE al LLM y cuestan cero. Son también lo que sigue funcionando
-- cuando se agota el presupuesto: el negocio nunca se queda mudo.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  config_id     uuid NOT NULL,
  name          text NOT NULL,

  -- Menor = antes. El dueño las ordena, y el orden es la mitad del producto.
  priority      integer NOT NULL DEFAULT 100,
  match_mode    text NOT NULL DEFAULT 'any',
  CONSTRAINT modo_match_valido CHECK (match_mode IN ('any','all')),

  conditions    jsonb NOT NULL,
  actions       jsonb NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,

  -- Franja horaria en MINUTOS desde medianoche, hora local del negocio.
  -- Minutos y no `time`: comparar horas como texto es la forma más fácil de
  -- equivocarse con el cruce de medianoche, y la regla de «fuera de horario»
  -- es justo la que tiene que cubrir de 23:00 a 02:00.
  active_from_minute integer CHECK (active_from_minute BETWEEN 0 AND 1439),
  active_to_minute   integer CHECK (active_to_minute BETWEEN 0 AND 1439),

  -- Contador de disparos: el panel del dueño enseña qué reglas se usan y
  -- cuáles no. Una regla que nunca dispara es una regla mal escrita.
  hit_count     integer NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, config_id)
    REFERENCES ai_agent_configs (tenant_id, id) ON DELETE CASCADE,
  -- O las dos horas o ninguna: media franja es una regla que no se sabe cuándo
  -- aplica.
  CONSTRAINT franja_completa CHECK (
    (active_from_minute IS NULL) = (active_to_minute IS NULL)
  )
);

ALTER TABLE ai_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_rules
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_ai_rules_config ON ai_rules (tenant_id, config_id, priority);

-- ---------------------------------------------------------------------------
-- FUENTES DE CONOCIMIENTO Y SUS FRAGMENTOS (RAG, T5.23).
--
-- El catálogo NO es una fuente de texto (spec 19 §2.4): es herramienta viva.
-- Meter precios aquí sería exactamente lo que RN-AIA-01 prohíbe — un precio
-- indexado hace seis meses que el modelo cita como vigente.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid,
  title         text NOT NULL,
  topic         text,
  body          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  -- Cuántas veces se usó para responder: el dueño ve qué material sirve.
  use_count     integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE ai_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_sources
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Fragmentos con su embedding.
 *
 * `tenant_id` en la propia tabla y RLS encima, aunque el fragmento ya cuelgue
 * de una fuente que lo tiene. Es redundante a propósito: la búsqueda por
 * similitud es un `ORDER BY embedding <=> $1 LIMIT k` y **si el filtro por
 * tenant dependiera de un JOIN, olvidarlo devolvería el material de otro
 * negocio ordenado por parecido** — sin error, sin aviso, con la respuesta
 * puesta en boca del agente. Con RLS sobre esta tabla, olvidarlo devuelve cero.
 */
CREATE TABLE ai_source_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  source_id     uuid NOT NULL,
  chunk_index   integer NOT NULL,
  content       text NOT NULL,
  -- 1536 dimensiones: el tamaño de los modelos de embedding habituales. Cambiar
  -- de modelo obliga a reindexar, y por eso la dimensión está en el esquema y
  -- no en la configuración: un cambio silencioso daría vecinos sin sentido.
  embedding     vector(1536),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id)
    REFERENCES ai_sources (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE ai_source_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_source_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_source_chunks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Índice de similitud coseno. `lists` bajo porque el volumen por tenant es
-- pequeño —son las políticas y el FAQ de un restaurante, no un corpus— y un
-- `lists` alto sobre pocas filas empeora el recall sin ganar velocidad.
CREATE INDEX idx_ai_chunks_embedding ON ai_source_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

CREATE INDEX idx_ai_chunks_fuente ON ai_source_chunks (tenant_id, source_id);

-- ---------------------------------------------------------------------------
-- USO Y PRESUPUESTO (ADR-0011 §4, T5.30).
-- ---------------------------------------------------------------------------
CREATE TABLE ai_budgets (
  tenant_id     uuid PRIMARY KEY REFERENCES ten_tenants (id) ON DELETE CASCADE,
  -- Créditos ENTEROS y no dinero: el precio del proveedor cambia y la moneda
  -- del plan es otra. Guardar soles obligaría a recalcular el histórico cada
  -- vez que un proveedor mueva su tarifa.
  limit_credits integer NOT NULL DEFAULT 0 CHECK (limit_credits >= 0),
  used_credits  integer NOT NULL DEFAULT 0 CHECK (used_credits >= 0),
  period_start  date NOT NULL DEFAULT current_date,
  warned_at     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_budgets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Traza de cada respuesta del agente (RN-AIA-05).
 *
 * «Toda conversación IA es auditable: traza completa reproducible». Sin esto,
 * la pregunta «¿por qué el bot le dijo eso a mi cliente?» no tiene respuesta, y
 * es la primera que hace un dueño cuando algo sale mal. Guarda qué regla
 * disparó, qué fuentes se usaron, qué herramientas se llamaron y qué dijo el
 * validador — incluido cuando BLOQUEÓ, que es el caso que más importa entender.
 */
CREATE TABLE ai_traces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  conversation_id uuid,
  config_id     uuid,

  inbound_text  text NOT NULL,
  outbound_text text,

  -- Cómo se resolvió: `rule` (determinista, coste cero), `llm`, `blocked`,
  -- `handoff` o `degraded` (presupuesto agotado).
  resolution    text NOT NULL,
  CONSTRAINT resolucion_valida
    CHECK (resolution IN ('rule','llm','blocked','handoff','degraded')),

  rule_id       uuid,
  source_ids    uuid[] NOT NULL DEFAULT '{}',
  tools_called  jsonb NOT NULL DEFAULT '[]',
  validator     jsonb,

  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  credits       integer NOT NULL DEFAULT 0,
  latency_ms    integer,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

ALTER TABLE ai_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_traces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_traces
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_ai_traces_conversacion
  ON ai_traces (tenant_id, conversation_id, created_at);
CREATE INDEX idx_ai_traces_resolucion
  ON ai_traces (tenant_id, resolution, created_at DESC);
