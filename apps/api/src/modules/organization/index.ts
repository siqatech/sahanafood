/** API pública del módulo Organization (spec 03). */
export { OrganizationModule } from './organization.module.js';
export {
  OrganizationService,
  type CoverageResult,
} from './app/organization.service.js';
export { seedDemoOrganization } from './app/demo-seed.js';
