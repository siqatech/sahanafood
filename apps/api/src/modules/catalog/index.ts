/** API pública del módulo Catalog (spec 04). */
export { CatalogModule } from './catalog.module.js';
export {
  CatalogService,
  type ResolvedCatalog,
  type ResolvedProduct,
  type ResolvedModifierGroup,
} from './app/catalog.service.js';
export { seedDemoCatalog, type DemoCatalog } from './app/demo-seed.js';
