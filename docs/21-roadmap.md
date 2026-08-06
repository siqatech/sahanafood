# Roadmap por fases

Detalle y criterios de salida por fase en `specs/phases/`. Ningún avance de fase sin cumplir su gate.

| Fase | Nombre | Contenido esencial | Estado |
|---|---|---|---|
| 0 | Investigación | Mercado, competidores, repositorios, licencias, riesgos | ✔ Documento maestro + este repo |
| 1 | Definición de producto | Visión, alcance, actores, reglas, módulos, MVP, métricas | ✔ docs/00–07 (validar con entrevistas: DP-08) |
| 2 | Arquitectura base | Dominio, tenancy, seguridad, datos, eventos, threat model | Este repo + ADRs; threat model pendiente |
| 3 | Fundamentos técnicos | Monorepo, CI/CD, IaC, identidad, tenancy+RLS, permisos, auditoría, outbox/inbox, observabilidad | Pendiente |
| 4 | Operación principal | Catálogo, orquestador, POS offline+print-agent, caja, KDS, impresión, simulador de marketplace, carga | Pendiente |
| 5 | Venta digital | Tienda web, pagos, bandeja omnicanal, agente IA configurable (sandbox+presupuesto), delivery básico, tracking; pentest | Pendiente |
| 6 | Inventario y costos | Recetas completas, kardex, compras, mermas, producción, rentabilidad | Pendiente |
| 7 | Integraciones reales | OSE definitivo, marketplaces (convenios iniciados en F4), conciliación | Pendiente |
| 8 | CRM, personal, analítica | Segmentación, campañas, turnos, servicio Python de pronóstico | Pendiente |
| 9 | Escala | Aislamiento dedicado enterprise, multi-país, HA, extracción medida de servicios | Pendiente |

Gestión comercial paralela (no bloquea): trámite Rappi/PedidosYa desde F4; cotización OSE en F3; verificación Meta Business en F4.
