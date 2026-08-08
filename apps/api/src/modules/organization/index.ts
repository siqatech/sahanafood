/** API pública del módulo Organization (spec 03). */
export { OrganizationModule } from './organization.module.js';
export {
  OrganizationService,
  type CoverageResult,
} from './app/organization.service.js';
export {
  OrganizationAdminService,
  type CompanyView,
  type BrandView,
  type LocationView,
  type ZoneView,
} from './app/organization-admin.service.js';
export { seedDemoOrganization } from './app/demo-seed.js';
