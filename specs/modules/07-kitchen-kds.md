# Módulo: Kitchen / KDS
> Fase: 4 (capacidad dinámica: 5) · Depende de: Ordering · ADRs: 0007

## Alcance
Tickets por estación, cola KDS ordenada por promised_at, temporizadores y alertas de atraso, marcado de avance, empaque con verificación y etiqueta por marca, capacidad y saturación (F5), pausa automática de canales (F5).
## Reglas
RN-KIT-01 order.accepted → 1 ticket por estación involucrada (según station_kind del producto). RN-KIT-02 Pedido `ready` cuando TODOS sus tickets ready (Ordering consume kitchen.ticket_ready). RN-KIT-03 Empaque: checklist de líneas + etiqueta con branding de la marca (nunca de otra: verificación por brand_id). RN-KIT-04 Saturación: ítems activos > max_concurrent → kitchen.saturated → promised_at +X min en received; segundo umbral → pausa de canales por política (orden: menor margen primero). RN-KIT-05 KDS funciona en la red local con datos ya sincronizados si se cae internet (cola local del punto).
## API/RT
WS: suscripción por estación · POST /tickets/:id/start | /ready · POST /orders/:id/pack {checklist} · GET /kitchen/load.
## Pruebas
Pedido 3 estaciones → ready solo con las 3 · saturación dispara evento y extiende promesas · etiqueta de marca correcta con 2 marcas simultáneas · reconexión WS sin perder tickets.
## Aceptación
Latencia aceptado→visible en KDS < 5 s (SLO); tablet 10" con letra legible a 1 m; cero toques para ver cola, 1 toque para avanzar.
