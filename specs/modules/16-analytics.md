# Módulo: Analytics
> Fase: 4 (básico, proyecciones en Postgres) / 8 (servicio Python)

F4 (en el monolito, leyendo proyecciones alimentadas por eventos, NUNCA las tablas transaccionales en caliente): ventas por canal/marca/local/hora · ticket promedio · food cost teórico · costo efectivo de canal (RN-BIL-04) · margen por producto/marca/canal · tiempos (aceptación, cocina, entrega) · cancelaciones por motivo.
F8 (servicio FastAPI separado, lee réplica/warehouse): pronóstico de demanda por franja, alertas de anomalías (caída de ventas, food cost fuera de banda, diferencia de arqueo recurrente), sugerencia de compra.
Regla: todo número monetario del dashboard debe cuadrar con Billing (test de conciliación diaria automática; divergencia → alerta, es bug crítico).
