# UX: Centro de operaciones (torre de control de pedidos)
> Usuario: supervisor/operador del turno. Web escritorio/tablet grande. Fase 4 (básico) / 5 (completo).

Pantalla única que responde "¿qué está entrando y qué necesita mi decisión AHORA?" — distinta del KDS (producción) y del panel (gestión).

## Layout
Columna 1 — **Por aceptar**: pedidos received de canales con aceptación manual, con cuenta regresiva del timeout (RN-ORD-04), botones Aceptar/Rechazar(motivo) grandes; needs_review destacado arriba con acceso a resolver mapeo. Columna 2 — **En curso**: tarjetas compactas por estado con semáforo, filtro por canal/marca. Columna 3 — **Problemas**: cancelaciones solicitadas, pagos fallidos, entregas fallidas, documentos rechazados, DLQ>0, conector degradado, POS offline >30 min — cada uno con la acción correctiva a un clic (runbooks embebidos).

## Cabecera viva
Pedidos/hora vs promedio · tiempo de cocina p95 del turno · saturación por cocina (barra) · botones de pánico: pausar canal, extender tiempos +10 min, activar "modo pico" (con confirmación y auditoría).

## Reglas
Cero refresh manual (WS) · sonido solo para "Por aceptar" y "Problemas" · todo elemento clickeable abre el timeline del pedido · accesible por rol supervisor con ámbito de local.
