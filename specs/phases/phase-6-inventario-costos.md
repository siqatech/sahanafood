# Fase 6 — Inventario y costos completos
Alcance: compras/proveedores · kardex completo · mermas y conteos · producción interna · costo promedio móvil · rentabilidad real por marca/canal (teórico vs real) · liquidación de repartidores · réplica de lectura para reportes.
Salida: conciliación food cost teórico vs consumo real con explicación de brecha · cierre mensual de inventario reproducible · test de consistencia kardex↔stock en CI.

---

## Backlog ordenado (T6.00 — generado desde las specs, pendiente de aprobación)

Derivado de: **spec 08 (Inventory, parte F6)**, spec 16 (Analytics), spec 09
(Delivery — liquidación de repartidores), docs/15 (réplica de lectura),
RN-INV-01..05 y RN-BIL-04.

**Lo que ya está en pie desde F4 y no se rehace:** insumos, recetas y
subrecetas con tope de 3 niveles, consumo automático en `order.accepted`,
reversa en cancelación, stock por almacén, kardex append-only con `UPDATE`/
`DELETE` revocados al rol de aplicación, y alertas de mínimo. Esta fase le pone
lo que le falta para que el food cost deje de ser **teórico**.

### La cadena que no se puede adelantar

1. **Compras antes que costo promedio móvil.** El costo promedio se recalcula
   *en la compra* (RN-INV-04). Sin una entrada de mercadería con precio real, el
   costo se quedaría en el que alguien tecleó al crear el insumo, que es
   exactamente la cifra que esta fase viene a sustituir.
2. **Costo promedio antes que rentabilidad real.** «Teórico vs real» no
   significa nada mientras el consumo se valore con un costo inventado.
3. **Mermas y conteos antes que el cierre mensual.** Un cierre que no puede
   explicar la brecha no es un cierre: es una diferencia sin nombre.
4. **Snapshot de costo en el movimiento, desde la primera tarea.** RN-INV-04 lo
   exige y es irrecuperable hacia atrás: si un movimiento no guarda el costo
   vigente en su momento, recalcular el histórico con el costo de hoy reescribe
   la rentabilidad de meses cerrados.

| ID | Tarea | Entregable verificable |
|---|---|---|
| **T6.00** | Generar este backlog desde specs y aprobarlo | Este documento aprobado |
| T6.01 | Proveedores (`inv_suppliers`) + condiciones de compra | CRUD con aislamiento; un proveedor no se borra si tiene compras: se desactiva |
| T6.02 | Órdenes de compra y **recepción de mercadería** | Recepción parcial permitida; la recepción es la que mueve stock, no la orden |
| **T6.03** | **Costo promedio móvil (RN-INV-04)** | **Se recalcula en la recepción y el movimiento guarda el costo VIGENTE (snapshot)**; recalcular el histórico no cambia meses cerrados. Property test: promedio ponderado exacto en céntimos, sin coma flotante |
| T6.04 | Transferencias entre almacenes | Salida y entrada en la MISMA transacción; una transferencia a medias es stock que desaparece |
| T6.05 | Mermas con motivo tipificado | Motivo obligatorio; merma sobre stock negativo permitida con alerta (RN-INV-02) |
| T6.06 | Conteos físicos (inventario cíclico) | Diferencia → ajuste **auditado**, nunca edición del kardex; conteo en curso no bloquea la venta |
| T6.07 | Producción interna (subrecetas producidas a stock) | Producir consume componentes y genera producto intermedio en una transacción; tope de 3 niveles vigente |
| T6.08 | Lotes y vencimientos (F6 tardía) | Consumo FEFO por defecto; alerta por vencimiento próximo. **Se cae del alcance sin dañar la salida de la fase** |
| **T6.09** | **Conciliación food cost teórico vs consumo real** | **La brecha se EXPLICA por origen**: merma registrada, diferencia de conteo, receta desactualizada, consumo sin pedido. Una brecha sin desglose no sirve para decidir nada |
| T6.10 | Rentabilidad real por marca y canal | Sustituye el food cost teórico de T4.29 por el real; **cuadra con Billing** (test de conciliación, divergencia = bug crítico) |
| **T6.11** | **Cierre mensual de inventario reproducible** | **Volver a correr el cierre del mes pasado da el MISMO número.** Un cierre que cambia al recalcularlo no cierra nada |
| T6.12 | Liquidación de repartidores (spec 09) | Cierra lo que T5.17 dejó a medias: el COD ya se liquida; falta la liquidación periódica con comprobante |
| T6.13 | **Test de consistencia kardex ↔ stock en CI** | **Suma del kardex = `inv_stock`, para todo insumo y almacén.** Bloqueante, como el de aislamiento |
| T6.14 | Concurrencia: 50 pedidos simultáneos sobre el mismo insumo | Stock final exacto; serialización por fila, no por tabla |
| T6.15 | Réplica de lectura para reportes (docs/15) | Los reportes pesados no tocan la primaria; **el retraso de réplica se muestra**, no se esconde |
| T6.16 | Gate F6 | Checklist `_gates-comunes` + criterios de salida de esta fase |

### Notas de planificación

- **T6.03 y T6.11 son el corazón de esta fase.** Un error en el costo promedio
  no se ve en un log: se ve seis meses después, en un plato que llevaba medio
  año vendiéndose por debajo de su costo. Y un cierre que no es reproducible
  convierte cualquier discusión sobre el mes pasado en una cuestión de fe.
  Ambos llevan property tests sobre céntimos enteros, no ejemplos.

- **El snapshot de costo es irreversible.** Es lo primero que hay que acertar:
  cada movimiento que se escriba sin él es un mes que no se podrá volver a
  valorar. Va dentro de T6.03 y no como tarea aparte a propósito.

- **La réplica de lectura (T6.15) depende de DT-02.** Sin entorno cloud no hay
  réplica que configurar. Puede implementarse contra una segunda conexión en
  local y quedar verificada de verdad solo al desplegar.

- **Lo que NO entra, aunque esté cerca:** sugerencia de compra y pronóstico de
  demanda (F8, y no es LLM), integración con proveedores por EDI (F7), y
  valoración FIFO/LIFO — la spec dice **promedio móvil** y añadir un segundo
  método multiplica por dos las formas de descuadrar un cierre.

- **Precondición de negocio:** F6 no debería abrirse antes de que los tres
  operadores piloto de F5 lleven un mes vendiendo. El inventario real solo se
  puede probar contra consumo real, y hasta entonces cualquier conciliación se
  valida contra datos sintéticos — que siempre cuadran.
