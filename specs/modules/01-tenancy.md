# Módulo: Tenancy (Núcleo SaaS)
> Fase: 3 · ADRs: 0002 · Depende de: —

## Alcance
Tenants, planes, suscripciones, límites (marcas/locales/usuarios por plan), feature flags por tenant, configuración de país/moneda/impuestos/zona horaria. NO: cobro de la suscripción (manual en MVP).
## Reglas
RN-TEN-01 Crear tenant provisiona: fila tenant + configuración por defecto Perú (PEN, IGV 18%, America/Lima) + usuario propietario + auditoría de alta. RN-TEN-02 Límites de plan verificados en creación de recursos (429 LIMIT_EXCEEDED, mensaje de upgrade). RN-TEN-03 Suspensión de tenant: bloquea login y API, NO borra datos; reactivable 90 días; borrado definitivo requiere doble confirmación + export previo.
## Entidades
`ten_tenants(id, name, status, plan_id, country, currency, settings jsonb)` · `ten_plans(id, code, limits jsonb, features jsonb)` · `ten_feature_flags(tenant_id, flag, enabled)`.
## API
POST /tenants (interno onboarding) · GET/PATCH /tenant (el propio) · GET /tenant/limits · flags leídos por middleware.
## Pruebas
Aislamiento (crítico), límites concurrentes (2 requests simultáneos al límite → solo 1 pasa), suspensión bloquea toda API.
## Aceptación
Onboarding de tenant demo < 60 s por script; RLS activo verificado en toda tabla creada por migraciones (test de esquema).
