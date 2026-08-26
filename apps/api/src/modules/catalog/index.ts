/** API pública del módulo Catalog (spec 04). */
export { CatalogModule } from './catalog.module.js';
export {
  CatalogService,
  type ResolvedCatalog,
  type ResolvedProduct,
  type ResolvedModifierGroup,
} from './app/catalog.service.js';
export {
  CatalogPublicationService,
  type PublishedVersion,
  type PublishedVersionWithSnapshot,
} from './app/catalog-publication.service.js';
export {
  CatalogAdminService,
  CatalogVersionConflictError,
  type CategoryView,
  type ProductView,
  type AdminProductView,
  type PriceView,
  type ModifierGroupView,
  type ModifierGroupWithOptions,
  type ModifierOptionView,
} from './app/catalog-admin.service.js';
export { seedDemoCatalog, type DemoCatalog } from './app/demo-seed.js';
