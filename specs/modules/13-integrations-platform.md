# Módulo: Plataforma de integraciones
> Fase: 4 (núcleo + SIMULADOR) / 7 (conectores reales) · ADRs: 0005, 0007, 0010

## Alcance
Conexiones por tenant (credenciales cifradas), anti-corruption layer (payload proveedor → contratos internos), mapeo de catálogo interno↔externo, ingesta por webhook (firma, dedupe, ack rápido, cola), propagación saliente (menú, disponibilidad, estados), salud por conector (circuit breaker, panel), reproceso desde DLQ. **Simulador de marketplace** como primer "conector".
## Simulador (entregable F4, bloqueante)
Emula: pedido entrante firmado · reintentos duplicados (mismo external_ref) · cancelación del canal · consulta de estado · payload malformado · ráfagas configurables (para k6). CLI + panel simple. Los conectores reales (F7) implementan la MISMA interfaz `ChannelConnector`.
## Reglas
RN-INT-01 Ack de webhook < 250 ms: validar firma + encolar; TODO lo demás en worker. RN-INT-02 Mapeo faltante → needs_review (RN-ORD-10), nunca descartar. RN-INT-03 Desactivar un conector no detiene el resto (bulkhead por proveedor). RN-INT-04 Credenciales: cifradas campo a campo, clave por tenant, nunca en logs. RN-INT-05 Propagación de disponibilidad: reintento con backoff; divergencia > 5 min → alerta (el canal sigue vendiendo lo pausado = pérdida).
## Interfaz ChannelConnector
`verifyWebhook(req)` · `parseOrder(payload) → NormalizedOrder` · `pushMenu(catalogVersion)` · `setAvailability(items)` · `updateOrderStatus(ref, status)` · `cancelAck(ref)`.
## Pruebas
Todas contra el simulador: ráfaga 10× sin pérdida (outbox=pedidos) · firma inválida → 401 sin encolar · circuit breaker abre y cierra · mapeo roto → bandeja · aislamiento de credenciales entre tenants.
## Aceptación F4
Orquestador certificado internamente contra simulador con el perfil de carga de docs/06. Esto es el gate para pedir certificación real a Rappi/PY en F7.
