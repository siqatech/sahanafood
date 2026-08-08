/**
 * API pública del módulo Storefront (spec 11).
 *
 * La tienda es un cliente del sistema, no una capa por debajo: consume
 * Catalog, Organization y Ordering, y nadie la consume a ella.
 */
export { StorefrontModule } from './storefront.module.js';
export {
  StorefrontService,
  type StorefrontContext,
  type CartView,
  type CartLineView,
} from './app/storefront.service.js';
