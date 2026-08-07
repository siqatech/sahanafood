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
| PA-02 | ¿Qué recursos, además de usuarios, cuentan contra los límites del plan y cómo se cuentan las marcas y locales? La spec 01 define límites de marcas/locales/usuarios, pero las entidades de organización llegan en T3.12. Hoy solo se hace cumplir el límite de usuarios. | spec 01 (Tenancy), T3.07 | Abierta — se cierra con T3.12 |
| PA-03 | ¿Los roles del sistema deben poder editarse por el tenant, o son inmutables y solo se permiten roles propios adicionales? Hoy se crean como `is_system = true` y no hay API de edición. | spec 02 (Identity), docs/03 | Abierta |

