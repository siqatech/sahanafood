# Fase 9 — Escala y expansión
Alcance (cada punto = ADR previo): aislamiento dedicado para enterprise (routing por conexión) · multi-país (impuestos/moneda/facturación por país; el 2º país exige su equivalente de OSE) · alta disponibilidad (multi-AZ, RTO ≤ 1 h, RPO ≤ 1 min) · extracción medida: ingestor → tiempo real → (analítica ya separada) · evaluación Kubernetes SOLO si hay ≥ 2 servicios extraídos y responsable de plataforma · SSO/Keycloak.
Salida: cliente enterprise en instancia dedicada sin fork de código · game day de DR regional en objetivo.
