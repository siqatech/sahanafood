# UX: POS (apps/pos, modo venta)
> Usuario: cajero bajo presión, a veces con guantes, pantalla con grasa. Sesión por PIN. Fase 4.

## Layout (tablet 10" horizontal)
Izquierda 60%: rejilla de productos (categorías arriba como pestañas grandes; búsqueda opcional al toque, no teclado permanente). Derecha 40%: ticket en curso (líneas, total GIGANTE abajo, botón COBRAR de ancho completo).

## Flujo de venta común: máximo 3 toques + cobro
producto → (modificadores si obligatorios) → COBRAR → método (efectivo con teclado de vuelto / tarjeta / yape-plin) → listo. El comprobante se imprime sin preguntar (config por defecto boleta simple; factura pide RUC con teclado numérico y autocompleta razón social vía padrón cuando hay internet, editable).

## Reglas de detalle
- Teclado de efectivo con atajos de billetes (10/20/50/100) y cálculo de vuelto en vivo.
- Modificadores: pantalla completa, obligatorios primero, contador min/max visible, no se puede confirmar incompleto (botón deshabilitado CON explicación).
- Descuento: botón visible pero pide PIN supervisor sobre el umbral (RN-T08); el motivo se elige de lista + texto libre.
- Cambio de mesa/para llevar/delivery propio: selector al inicio del ticket, cambia flujo de datos mínimos (delivery pide teléfono y dirección con autocompletado de zonas).
- Pedidos en curso: pestaña con tarjetas (mismo componente que KDS); reimprimir/anular/cobrar pendiente desde ahí.
- Offline: banner ámbar persistente "Sin conexión — ventas se guardan aquí" + contador; al volver, "Sincronizando (n)…" y toast final. Nada más cambia: MISMO flujo.
- Cierre de caja: pantalla de conteo con teclado por denominación (billetes/monedas), diferencia calculada en vivo, motivo obligatorio si ≠ 0, imprime resumen.

## Anti-requisitos
Sin menús hamburguesa en flujo de venta. Sin doble confirmación para acciones reversibles. Sin scroll horizontal. Sin tooltips como único medio de información.
