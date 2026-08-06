# Seguridad

## Autenticación y sesiones
JWT 15 min + refresh rotativo con detección de reutilización (revoca familia). MFA TOTP opcional MVP, obligatoria para admin en v1. POS: registro de dispositivo + PIN por operador; acciones sensibles re-piden PIN. Recuperación por email con token de un uso, 15 min.

## Autorización
RBAC con ámbito (empresa/marca/local/cocina) + condiciones (monto máx. de descuento, turno). Verificación SIEMPRE en backend por guard de módulo. Anti-IDOR/BOLA: RLS + prueba de aislamiento por endpoint + IDs opacos.

## Datos
TLS 1.2+ en tránsito. Cifrado en reposo del volumen + campo a campo (AES-256-GCM, clave por tenant vía KMS) para: credenciales de conectores, tokens, datos personales sensibles. Sin datos de tarjeta (SAQ-A). Retención y anonimización: pedidos 5 años (fiscal), datos personales anonimizables a solicitud (Ley 29733) sin romper trazabilidad contable.

## Perímetro
Rate limiting: 100 req/min por usuario, 1000/min por tenant, 20/min en login (por IP+cuenta, backoff). Validación de entrada con zod en el borde. Subida de archivos: tipo real verificado, tamaño máx., re-encodado de imágenes, sin SVG de usuarios.

## Webhooks entrantes
Verificación de firma del proveedor + timestamp anti-replay + dedupe por `(provider, event_id)` en inbox. Secretos por conexión, rotables sin corte (aceptar 2 versiones durante ventana).

## Secretos
Gestor de secretos del proveedor cloud; nunca en repo ni en variables planas de CI visibles. Rotación: credenciales de BD 90 días, secretos de webhook 180 días, claves de tenant anual.

## Auditoría {#auditoria}
Append-only (`audit_log`, rol de app sin UPDATE/DELETE; respaldo a objeto WORM diario). Se auditan: anulación/NC de comprobantes, cambios de precio, descuentos > umbral, cancelaciones y reembolsos, modificación de pedido aceptado, ajustes de inventario, cambios de permisos, apertura/cierre de caja con diferencia, acceso de soporte cross-tenant (con motivo), exportaciones masivas. Registro: quién, cuándo, desde dónde, antes, después, motivo, trace_id, tenant.

## Threat model
STRIDE por flujo crítico (pedido, pago, sync offline, webhook) se elabora en F2 y se revisa por fase. Pentest externo antes del GA (salida de F5).

## OWASP
Checklist Top 10 + API Top 10 en el gate de cada fase (specs/phases). Dependencias: escaneo en CI (audit + SCA), SBOM generado por release, parches críticos < 72 h.
