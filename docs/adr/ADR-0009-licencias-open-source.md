# ADR-0009 — Régimen de licencias de referencias open source

Estado: Propuesto · Fecha: 2026-08-05

## Contexto
Se estudian repositorios con licencias copyleft. Copiar código GPL/LGPL/AGPL en un SaaS propietario puede obligar a liberar código o crear riesgo legal. El análisis técnico no sustituye revisión legal.

## Decisión
1. Régimen por defecto: **Referenciar** (leer, aprender, documentar el aprendizaje). Prohibido copiar código, esquemas SQL literales, textos de UI o activos.
2. Licencias declaradas (verificar contra el commit exacto antes de cualquier excepción — pueden cambiar): Odoo Community LGPLv3 · ERPNext GPLv3 · Frappe Framework MIT · URY GPLv3 (deriva de ERPNext) · TastyIgniter MIT · OSPOS MIT · Floreant (histórica MPL-derivada; VERIFICAR) · uniCenta GPL · Medusa MIT · Vendure MIT/GPL dual (VERIFICAR edición) · Chatwoot MIT+enterprise · Keycloak Apache-2.0 · OpenTelemetry Apache-2.0 · Superset Apache-2.0.
3. Cualquier "Adaptar" (usar fragmento o dependencia directa) exige: licencia permisiva verificada en el commit + registro en docs/repositories/ + aprobación explícita. Copyleft: nunca adaptar, solo referenciar. Keycloak/OTel/Superset pueden usarse COMO SERVICIOS (no se deriva código): permitido.
4. SBOM por release + escaneo de licencias de dependencias npm en CI (bloquear GPL transitivo en el bundle).
