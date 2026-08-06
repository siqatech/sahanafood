# Módulo: Inventory
> Fase: 4 (recetas+consumo) / 6 (completo) · ADRs: 0007

## Alcance
F4: insumos, recetas/subrecetas, consumo automático al order.accepted, stock por almacén, mínimos y alertas. F6: compras, proveedores, transferencias, mermas, conteos, producción interna, costo promedio móvil, lotes/vencimientos (F6 tardía).
## Reglas
RN-INV-01 Consumo = receta × qty, con waste_pct; a nivel (cocina→almacén asignado); costo atribuido a marca del pedido (docs/07 §3). RN-INV-02 Kardex append-only; stock materializado; NEGATIVO permitido con alerta (RN-T07) — jamás bloquear una venta por stock. RN-INV-03 Cancelación pre-preparación → reversa de consumo; post → merma con motivo. RN-INV-04 Costo promedio móvil recalculado en compra; el costo del consumo es el vigente al momento (snapshot en movimiento). RN-INV-05 Subrecetas máx. 3 niveles; ciclo → error de validación.
## API
CRUD insumos/recetas · GET /stock?warehouse · POST /movements (ajuste con motivo+permiso) · F6: compras, mermas, conteos con diferencia→ajuste auditado.
## Pruebas
Consumo con subreceta anidada · reversa exacta en cancelación · negativo + alerta · concurrencia: 50 pedidos simultáneos mismo insumo → stock final exacto (serialización por fila) · aislamiento.
## Aceptación
Food cost teórico por producto y por marca visible en analítica F4; kardex cuadra contra movimientos en test de consistencia.
