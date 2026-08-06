# Glosario

| Término | Definición |
|---|---|
| Tenant | Cliente del SaaS. Raíz de aislamiento de datos. Un tenant puede tener varias empresas. |
| Empresa | Entidad legal (RUC) que emite comprobantes. |
| Marca | Identidad comercial de cara al cliente final. Virtual o física. |
| Local | Punto físico. Puede alojar una o más cocinas. |
| Cocina | Unidad de producción. Relación marca↔cocina: muchos-a-muchos. |
| Estación | Subunidad de la cocina (plancha, fritura, empaque). |
| Canal | Origen del pedido: pos, web, whatsapp, marketplace:<nombre>, callcenter, qr. |
| Pedido normalizado | Pedido traducido al modelo canónico interno, independiente del canal. |
| Comanda | Proyección del pedido para producción (por estación). |
| Receta | Lista de insumos y cantidades por producto vendible. Subreceta: receta usada como insumo. |
| Kardex | Registro de movimientos de stock por insumo y almacén. |
| Costo efectivo de canal | Comisión + descuentos absorbidos + fees fijos + campañas, por canal. |
| Outbox | Tabla donde se escriben eventos en la misma transacción del cambio de estado. |
| Inbox | Tabla de deduplicación de eventos consumidos. |
| OSE/PSE | Operador/Proveedor de Servicios Electrónicos autorizado por SUNAT. |
| Ventana de servicio | Ventana de 24 h de WhatsApp abierta por mensaje del cliente. |
