# UX: KDS (apps/pos, modo cocina)
> Usuario: cocinero a 1–2 m, manos ocupadas/mojadas, ruido. Tema oscuro alto contraste. Fase 4.

## Layout
Columnas por estado (Nuevos / En preparación / Listos) o vista por estación (config). Tarjetas grandes: nº corto ENORME, canal (color+ícono), marca, ítems con cantidad en negrita, notas en amarillo, alérgenos banda roja, cronómetro con semáforo.

## Interacción
- Un toque en la tarjeta = avanzar estado (start→ready). Deshacer 8 s. Targets ≥ 64 px.
- Sonido por pedido nuevo (distinto por canal) + flash del borde. Volumen y mute por franja horaria configurables.
- Pedido programado aparece atenuado con cuenta regresiva y se activa solo a t-prep (RN-ORD-05).
- Ítem individual marcable en pedidos grandes (tap en la línea) para coordinar estaciones.
- Empaque: checklist tocable por línea + botón imprimir etiqueta de marca; no permite "empacado" con líneas sin verificar (RN-KIT-03).
- Saturación: cuando kitchen.saturated, banner rojo arriba con causa y botón "ver carga"; las promesas extendidas se reflejan en los cronómetros.
- Reconexión WS transparente: si se pierde, banner y la cola local sigue visible (no pantalla en blanco JAMÁS).

## Vista TV (solo lectura)
URL de kiosk sin sesión interactiva (token de dispositivo) para colgar en TV: cola + tiempos, sin botones.
