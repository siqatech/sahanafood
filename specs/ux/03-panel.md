# UX: Panel de gestión (apps/web)
> Usuarios: dueño (celular, consulta), administrador (desktop, configuración). Fase 4–5.

## Principio
**Consultar es mobile-first; configurar es desktop-first.** El dueño abre el celular a las 11 pm: la home responde en una pantalla "¿cómo vamos hoy?" — ventas del día vs mismo día semana pasada, por marca y canal (colores de canal), ticket promedio, cancelaciones, pedidos activos ahora. Cero configuración visible ahí.

## Estructura
Home (hoy) · Pedidos (buscador + timeline por pedido = la misma vista de trazabilidad del runbook 1, versión operador) · Catálogo · Inventario · Caja y comprobantes · Clientes · Configuración (empresa/marcas/locales/usuarios/integraciones/impresoras) · Novedades.

## Detalles
- Todo listado: filtros por chips (canal, marca, local, estado, rango), export CSV, columnas de dinero alineadas derecha.
- Edición de catálogo con vista previa del canal ("así se ve en la tienda / en el POS") y publicación explícita con diff ("3 precios cambian, 1 producto se pausa").
- Acciones peligrosas (anular comprobante, borrar producto con historial): modal con motivo escrito + consecuencias listadas.
- Panel de integraciones: tarjeta por conector con salud (verde/ámbar/rojo), último evento, botón reintentar DLQ, y logs legibles (hora local del local).
- Onboarding checklist persistente hasta completarse (docs/26).
- Roles: la UI oculta lo no permitido pero el backend es la autoridad (docs/14); nada de botones que fallan con 403 sorpresa.
