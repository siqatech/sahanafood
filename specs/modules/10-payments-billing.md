# Módulo: Payments & Billing
> Fase: 4 (billing) / 5 (pagos online) · ADRs: 0003, 0010

## Alcance
Payments: adaptador de pasarela (Culqi/Izipay/Niubiz/MercadoPago) por tenant, intenciones de pago, webhooks de confirmación, links de pago, reembolsos, conciliación de pasarela. Billing: emisión boleta/factura/NC vía adaptador OSE/PSE, series por empresa, cola diferida offline, comisiones por canal (estimada vs liquidada).
## Reglas
RN-PAY-01 Pedido online se confirma SOLO con webhook de pago verificado (nunca redirect del navegador). RN-PAY-02 Sin datos de tarjeta en nuestra infraestructura (SAQ-A). RN-PAY-03 Reembolso > umbral → doble aprobación. RN-BIL-01 Serie/correlativo por empresa+tipo, asignación transaccional sin huecos por errores (correlativo se toma al emitir, no al encolar). RN-BIL-02 Documento rechazado por OSE → cola de corrección con alerta; NUNCA se pierde la venta. RN-BIL-03 Venta offline → documento encolado con fecha de emisión real; límite de antigüedad configurado con alerta previa. RN-BIL-04 pay_channel_fees: estimada al aceptar (según tarifario del canal), liquidada al conciliar; diferencia reportada.
## API
POST /payments/intents · webhook /payments/callbacks/:provider**/:token** (firma) · POST /payments/:id/refund · POST /documents (interno desde Ordering/POS) · GET /documents?status · POST /documents/:id/retry · POST /credit-notes.
## Pruebas
Webhook duplicado de pasarela → 1 solo confirmado · pago confirmado tras timeout del pedido → reembolso automático + alerta · correlativo bajo concurrencia sin duplicar ni saltar · OSE caído (mock) → cola y reintento · aislamiento.
## Aceptación
Flujo completo tienda: intent → webhook → accepted → boleta emitida (sandbox OSE) < 2 min; NC vinculada correcta en cancelación post-facturación.

## Divergencia registrada (T5.03, ADR-0016)

La ruta del webhook lleva **un segmento más** que el escrito arriba: un token
opaco por conexión (`/payments/callbacks/:provider/:token`).

Motivo: la pasarela avisa sin ningún token nuestro, así que hay que averiguar de
qué tenant es el cobro **antes** de poder verificar la firma. Con la ruta sin
token, esa resolución solo puede hacerse leyendo la referencia del payload, lo
que obligaría a abrir un escape de RLS sobre `pay_intents` — una tabla **con
importes**. ADR-0014 sostiene la seguridad de todo el patrón de escapes sobre lo
contrario: que ninguna tabla de negocio los mencione.

Con el token, el escape recae sobre `pay_connections`, que guarda credenciales.
Es realista: las pasarelas del mercado permiten configurar la URL de
notificación por comercio.
