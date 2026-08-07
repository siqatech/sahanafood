# Registro de riesgos

| ID | Riesgo | Prob. | Impacto | Mitigación | Dueño | Estado |
|---|---|---|---|---|---|---|
| R-01 | Aprobación de marketplaces demora >6 meses | Media | Alto | Simulador F4; agregador plan B; canal propio primero | Comercial | Abierto |
| R-02 | Costo WhatsApp post 10/2026 encarece canal | Alta | Medio | Flujos de mínimos turnos; métrica msg/pedido; traslado a plan | Producto | Abierto |
| R-03 | Fuga entre tenants | Baja | Crítico | RLS + pooling transaccional + test por endpoint + FKs compuestas | Ingeniería | Mitigándose |
| R-04 | Descuadre de dinero por float | Media | Crítico | Money entero + lint + property tests | Ingeniería | Mitigándose |
| R-05 | Divergencia cálculo offline/servidor | Media | Crítico | @sahana/domain compartido (ADR-0006/0008) | Ingeniería | Mitigado por diseño |
| R-06 | Impresión desde PWA imposible sin agente | Certeza | Alto | print-agent obligatorio (ADR-0008) | Ingeniería | Mitigado por diseño |
| R-07 | Pérdida de eventos entre commit y publicación | Media | Alto | Outbox transaccional (ADR-0007) | Ingeniería | Mitigado por diseño |
| R-08 | Cambios normativos SUNAT | Alta | Alto | OSE/PSE adaptador; monitoreo de resoluciones | Ingeniería | Abierto |
| R-09 | Contaminación de licencia por copiar código GPL | Baja | Crítico | ADR-0009: solo referencia; revisión legal antes de cualquier adaptación | Legal | Abierto |
| R-10 | Mercado dark kitchen menor al estimado | Media | Alto | Entrevistas (DP-08); producto sirve también a delivery-first | Producto | Abierto |
| R-11 | Sobrecoste de infraestructura temprana | Media | Medio | Presupuesto mensual objetivo MVP < USD 600; revisión mensual | DevOps | Abierto |
| R-13 | Bot IA alucina precios/promesas y daña confianza | Media | Alto | ADR-0011: determinista primero, validador de salida, suite dorada en CI | Ingeniería | Mitigado por diseño |
| R-14 | Costo IA por conversación erosiona margen del plan | Media | Medio | Créditos por plan, acciones deterministas gratis, métrica costo/pedido | Producto | Abierto |
| R-12 | Equipo sin experiencia TS suficiente | ? | Alto | Disparador 1 de ADR-0006: revertir a Laravel+Flutter | Dirección | **Bloqueante de aprobación** |

## Decisiones pendientes (DP)
DP-01 stack confirmado por equipo real · DP-02 proveedor OSE/PSE (3 cotizaciones) · DP-03 ruta marketplaces directa vs agregador · DP-04 BSP vs Cloud API directa WhatsApp · DP-05 modelo de precios del SaaS · DP-06 pasarela por defecto onboarding · DP-07 alcance offline validado con operadores · DP-08 entrevistas 8–10 operadores Lima (cierra F0/F1) · DP-09 proveedor LLM y de embeddings del adaptador AiProvider (F5) · DP-10 proveedor de correo transaccional (F5).

## Preguntas abiertas surgidas en implementación

Registradas por Claude Code al no estar cubiertas por una spec (regla 2 de CLAUDE.md).
Requieren decisión del propietario antes de cerrar el módulo afectado.

| ID | Pregunta | Origen | Estado |
|---|---|---|---|
| PA-01 | **¿Un mismo email puede pertenecer a varios tenants?** El login recibe el email antes de conocer el tenant. Hoy, si el email existe en más de un tenant, la implementación RECHAZA el acceso en vez de adivinar. Alternativas: (a) prohibirlo globalmente, (b) pedir el tenant en el login (subdominio o selector), (c) devolver una lista para que el usuario elija. Afecta al onboarding y a la experiencia de un operador que trabaja para dos clientes. | spec 02 (Identity), T3.08 | **Abierta — decisión del propietario** |
| PA-02 | ¿Qué recursos, además de usuarios, cuentan contra los límites del plan? Las entidades `org_brands` y `org_locations` ya existen (T3.12), así que el conteo es posible; falta decidir si el límite se aplica a marcas ACTIVAS o a todas, y qué ocurre con las existentes al bajar de plan. | spec 01 (Tenancy), T3.07/T3.12 | **Abierta — decisión del propietario** (desbloqueada por T3.12) |
| PA-03 | ¿Los roles del sistema deben poder editarse por el tenant, o son inmutables y solo se permiten roles propios adicionales? Hoy se crean como `is_system = true` y no hay API de edición. | spec 02 (Identity), docs/03 | Abierta |

| PA-04 | La spec 05 §9 cataloga los códigos de error de pedidos y **no incluye ninguno para «la marca no se produce en el local»** (RN-ORD-09 sí exige la validación). Se implementó con código propio `ORDER_BRAND_NOT_SERVED` (409). Falta confirmar el nombre antes de que haya clientes atados a él: un código publicado ya no se cambia sin romper integraciones. | spec 05 §9, T4.10 | Abierta — confirmar nomenclatura |
| PA-05 | RN-ORD-09 menciona «productos disponibles en (canal, local, **horario**)», pero la spec 05 §9 no cataloga ningún error de «local cerrado» y la validación no se implementó. Hoy un pedido entra aunque el local esté fuera de horario; en marketplaces no ocurre porque el menú se apaga, pero en canales propios sí es alcanzable. Decidir si se rechaza, se aparta a `needs_review` o se acepta como programado. | spec 05 §9, T4.10 | Abierta — decisión del propietario |
