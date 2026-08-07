/** API pública del módulo Tenancy (spec 01). */
export { TenancyModule } from './tenancy.module.js';
export {
  TenancyService,
  type TenantView,
  type LimitsView,
  type PlanLimits,
  type CountableResource,
} from './app/tenancy.service.js';
