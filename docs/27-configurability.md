# Configurabilidad total

Principio de producto: **todo módulo y toda función visible se puede activar o desactivar por tenant (y donde aplique, por marca o local), con defaults por plan y por rubro.** La configurabilidad no es una pantalla de ajustes gigante: es arquitectura.

## 1. Tres niveles de configuración
| Nivel | Qué controla | Dónde vive | Quién lo cambia |
|---|---|---|---|
| Plan | Módulos incluidos, límites, créditos IA | ten_plans.features/limits | Sahana (comercial) |
| Tenant | Activar/desactivar módulos del plan, integraciones, agente IA, políticas | ten_feature_flags + config de módulo | Dueño/admin |
| Marca / Local | Branding, horarios, catálogo, canales activos, modos del agente, impresoras, zonas | Config por entidad en cada módulo | Admin/supervisor |

Reglas: (1) desactivar un módulo OCULTA su UI y desactiva sus jobs, pero NUNCA borra datos; (2) las dependencias se declaran: no se puede activar Delivery propio sin Zonas; la UI lo explica; (3) todo cambio de configuración es auditado; (4) los defaults por rubro (pollería, hamburguesería, cafetería, dark kitchen multimarca) vienen de plantillas de onboarding (docs/26).

## 2. Configurabilidad del catálogo (nivel Agiliza360+)
- Producto: nombre, categoría, descripción, foto (con "Mejorar con IA"), precio base + precios por canal/local, impuesto, estación de cocina, receta opcional, **ID externo por canal** (mapeos de integración), instrucciones especiales de operación, alérgenos, etiquetas.
- **Disponibilidad fina** (patrón Agiliza360): habilitado on/off · franjas horarias generales · por día de semana · fechas específicas (feriados, campañas) · por canal. Motor único de disponibilidad consultado por tienda, POS, agente IA y conectores.
- Modificadores: grupos con min/max, obligatorios/opcionales, precio ±, disponibilidad propia, límite por opción (máx. 10 de una salsa, patrón visto en carta de Smash Burger).
- **Campos personalizados acotados:** `custom_fields jsonb` por producto con esquema declarado por tenant (texto/número/booleano/lista) para atributos de rubro (picor, tamaño, origen) que la tienda y el agente pueden mostrar. Sin lógica sobre campos custom en MVP (solo mostrar/filtrar).
- Carta digital configurable con vista previa en vivo (specs/ux/04): vista por cuadrantes o lista, colores, tipografía dentro del sistema, orden de categorías, "simular cerrado".

## 3. Motor de reglas ligero (compartido)
Las "acciones" del agente IA (spec 19), las políticas de saturación (RN-KIT-04), la autopausa por stock y las reglas de notificación usan el MISMO evaluador interno: condición (evento/atributo + operador + valor, combinables con Y/O) → acción del catálogo de acciones del módulo. Persistidas como jsonb versionado, evaluadas en el servidor, con prueba en sandbox donde aplique. Esto evita tres motores de reglas divergentes. Límite explícito: NO es un workflow builder genérico (eso es n8n y está vedado del núcleo); las condiciones y acciones son las del catálogo tipado de cada módulo.

## 4. Catálogo de servicios de WhatsApp Cloud API que se usan (contrato del conector)
Versión API objetivo: la vigente al iniciar F4 (fijar en la ficha del conector). Servicios:
| Servicio | Uso en Sahana | Fase |
|---|---|---|
| Mensajes de texto (ventana 24 h) | Conversación del agente y del humano | 4–5 |
| Interactive: reply buttons (≤3) | Confirmaciones sí/no, elegir recojo/delivery | 5 |
| Interactive: list messages (≤10 ítems) | Menú de opciones, categorías, horarios | 5 |
| Media (imagen) | Foto de producto desde catálogo | 5 |
| Location (pedir/recibir) | Dirección para cobertura | 5 |
| Plantillas UTILITY | Estados del pedido, confirmaciones, tracking, comprobante | 4 |
| Plantillas MARKETING | Campañas CRM con consentimiento (presupuesto) | 8 |
| Plantillas AUTHENTICATION | OTP de registro/recuperación (si se usa) | 5 |
| WhatsApp Flows | Formularios nativos (dirección/datos) — EVALUAR en F5, no bloquear | 5+ |
| Webhooks: messages + statuses | Ingesta, entregado/leído/fallado, calidad del número | 4 |
| Gestión de plantillas por API | Alta y estado de aprobación desde el panel | 5 |
| Múltiples números | Un número por marca (o compartido con selector de marca) | 5 |
| Catálogo de Meta | NO en MVP (duplica el catálogo; evaluar v2 solo si mejora conversión) | — |
Decisión pendiente DP-04 (BSP vs Cloud API directa) sigue abierta; el conector abstrae ambos.

## 5. Correo: adaptador EmailProvider
Proveedor transaccional vía adaptador (candidatos: SES, Resend, Postmark — decidir en F5 por entregabilidad/costo, ADR al elegir). Usos y plantillas (todas editables por tenant con variables tipadas y branding de marca): confirmación de pedido, tracking, comprobante adjunto/link, recuperación de contraseña, invitación de usuario, recuperación de carrito (F8, con consentimiento), campañas (F8). Requisitos: dominio de envío por tenant opcional (SPF/DKIM guiado), supresión por rebote/queja automática, y correo NUNCA en la ruta crítica del pedido (siempre asíncrono, cola notifications).

## 6. Matriz on/off inicial (lo que el dueño ve en Ajustes → Módulos)
Tienda web · Agente IA (por marca) · Bandeja/atención humana · Delivery propio · Recojo · Pedidos programados · Inventario/recetas · Compras y mermas · CRM y cupones · Campañas · Personal · Facturación electrónica (requiere OSE configurado) · Integraciones (por conector) · Analítica avanzada. Cada tarjeta: qué hace, qué requiere, botón activar, y qué pasa al desactivar.
