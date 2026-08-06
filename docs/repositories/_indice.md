# Análisis de repositorios

Método: docs del prompt maestro §5. Cada ficha fija rama/commit y fecha al momento del análisis profundo (F0 tardía / F2). Clasificación: Adoptar / Adaptar / Referenciar / Evitar. Régimen legal: ADR-0009.

| Repo | Licencia declarada (verificar) | Clasificación | Qué se toma |
|---|---|---|---|
| Odoo Community | LGPLv3 | Referenciar | Modelo BoM/MRP, sesiones POS, valorización de inventario |
| URY ERP | GPLv3 | Referenciar (prioritaria) | KDS/KOT multi-cocina, flujo dark kitchen, offline POS |
| ERPNext/Frappe | GPLv3 / MIT | Referenciar | Kardex, workflows de documentos, permisos por rol+doc |
| TastyIgniter | MIT | Referenciar (candidato a Adaptar patrones) | Checkout, zonas de cobertura, horarios por local |
| Floreant POS | verificar | Referenciar | Arquitectura de impresión y tolerancia a fallos → diseño de print-agent |
| Open Source POS | MIT | Referenciar | Arqueo de caja, permisos simples |
| uniCenta oPOS | GPL | Referenciar | Periféricos y terminales |
| Medusa / Vendure | MIT / dual | Referenciar | Módulos headless, price lists por canal |
| Chatwoot | MIT+ent | Evaluar como servicio | Bandeja omnicanal para derivación humana WhatsApp (F5) |
| Keycloak | Apache-2.0 | Evaluar como servicio (F9) | SSO/MFA enterprise; MVP usa auth propia |
| n8n | Sustainable Use | Evitar en núcleo | Solo prototipos internos; prohibido en flujo transaccional |
| OpenTelemetry / Superset | Apache-2.0 | Adoptar como herramienta | Observabilidad / BI interno |

Ficha detallada por repo: crear `docs/repositories/<slug>.md` con el checklist del prompt maestro al hacer el análisis profundo (tarea de F2, estimada 1 día por repo prioritario).
