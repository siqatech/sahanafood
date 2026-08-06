# Módulo: Identity
> Fase: 3 · ADRs: 0002 · Depende de: Tenancy

## Alcance
Usuarios, invitaciones, roles con ámbito, permisos, sesiones (JWT+refresh rotativo), dispositivos POS, PIN de operador, MFA TOTP (opcional MVP). NO: SSO (F9, Keycloak como servicio).
## Reglas
RN-IDN-01 Permiso = (acción, módulo, ámbito{empresa|marca|local|cocina}) + condiciones (monto_max, turno). RN-IDN-02 Refresh reutilizado → revocar familia completa + alerta. RN-IDN-03 PIN: 4–6 dígitos, hash argon2, bloqueo 5 intentos/15 min, cambio obligatorio al primer uso. RN-IDN-04 Dispositivo POS se registra con código de emparejamiento de un uso emitido por admin; token de dispositivo revocable.
## Entidades
`idn_users`, `idn_roles`, `idn_role_permissions`, `idn_user_roles(user, role, scope_type, scope_id)`, `idn_sessions`, `idn_devices`, `idn_invitations`.
## API
POST /auth/login · /auth/refresh · /auth/logout · POST /auth/pin-verify (para acciones sensibles POS) · CRUD /users /roles · POST /devices/pair.
## Pruebas
Ámbito: supervisor de local A no ve local B (misma empresa) · rotación y reuso de refresh · fuerza bruta de PIN · aislamiento.
## Aceptación
Matriz permiso×rol de docs/03 implementada y testeada; guard reutilizable `@RequirePermission('orders.cancel', scope)` disponible para todos los módulos.
