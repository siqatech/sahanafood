# Requisitos funcionales

Índice maestro. El detalle vive en `specs/modules/`. Prioridad: M=MVP, 1=v1 post-MVP, 2=crecimiento, E=empresarial, X=fuera de alcance.

| ID | Requisito | Prioridad | Spec |
|---|---|---|---|
| RF-01 | Alta de tenant, empresa, marca, local, cocina; marca↔cocina M:N | M | 03-organization |
| RF-02 | Usuarios, roles con ámbito (empresa/marca/local), sesión POS por PIN | M | 02-identity |
| RF-03 | Catálogo: productos, variantes, modificadores, combos, precios por canal y local | M | 04-catalog |
| RF-04 | Disponibilidad por horario, agotados por canal en <60 s | M | 04-catalog |
| RF-05 | Orquestador: ingesta, normalización, dedupe, máquina de estados única | M | 05-ordering |
| RF-06 | Aceptación automática o manual por canal; pedidos programados | M | 05-ordering |
| RF-07 | POS offline: vender, imprimir, cobrar sin internet; sincronizar después | M | 06-pos-cash |
| RF-08 | Caja: apertura, cierre, arqueo, medios de pago, pago mixto | M | 06-pos-cash |
| RF-09 | KDS por estación, temporizadores, orden por tiempo prometido | M | 07-kitchen-kds |
| RF-10 | Capacidad de cocina, tiempo prometido dinámico, pausa automática de canal | 1 | 07-kitchen-kds |
| RF-11 | Empaque: verificación y etiqueta por marca | M | 07-kitchen-kds |
| RF-12 | Recetas/subrecetas, consumo automático al aceptar pedido | M | 08-inventory |
| RF-13 | Compras, kardex, mermas, conteos, costos promedio móvil | 1 | 08-inventory |
| RF-14 | Tienda web por marca: delivery, recojo, invitado, dominio propio | M | 11-storefront |
| RF-15 | Cobertura por zona (polígonos), tarifa por zona | M | 09-delivery |
| RF-16 | Pago online (adaptador de pasarela), contra entrega, links de pago | M | 10-payments-billing |
| RF-17 | Comprobantes SUNAT vía OSE/PSE, cola diferida offline, notas de crédito | M | 10-payments-billing |
| RF-18 | WhatsApp: notificaciones de estado por plantilla | M | 12-whatsapp |
| RF-19 | WhatsApp: toma de pedido con bot + derivación humana con contexto | 1 | 12-whatsapp |
| RF-20 | Plataforma de conectores + simulador de marketplace | M(sim) | 13-integrations-platform |
| RF-21 | Marketplaces reales (Rappi, PedidosYa) | 2 | 13-integrations-platform |
| RF-22 | Repartidores propios: asignación, tracking, evidencia, liquidación | 1 | 09-delivery |
| RF-23 | CRM: perfil, historial, cupones, segmentación, campañas | 1–2 | 14-crm |
| RF-24 | Personal: turnos, asistencia, productividad | 2 | 15-workforce |
| RF-25 | Analítica: ventas por canal/marca, food cost, costo efectivo de canal | M básico | 16-analytics |
| RF-26 | Pronóstico de demanda y anomalías | E | 16-analytics |
| RF-27 | Auditoría inalterable de acciones críticas | M | 17-audit |
| RF-28 | Bandeja omnicanal: colas, asignación, notas, plantillas, acciones de pedido | 1 | 18-conversations-inbox |
| RF-29 | Agente IA configurable: personalidad, pautas, acciones deterministas, fuentes, sandbox, presupuesto | 1 | 19-ai-agent |
| RF-30 | Centro de operaciones (torre de control con aceptación y problemas) | M básico | ux/05 + 05-ordering |
| RF-31 | Configurabilidad total: módulos on/off por tenant, disponibilidad fina de catálogo, campos personalizados, plantillas de correo | M | docs/27 |
