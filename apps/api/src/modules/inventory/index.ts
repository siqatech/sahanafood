/**
 * API pública del módulo Inventory (spec 08 parcial).
 *
 * `InventoryEventHandlers` es lo que el worker monta para que el inventario se
 * entere de los pedidos aceptados y cancelados.
 */
export { InventoryModule } from './inventory.module.js';
export {
  InventoryService,
  RecipeCycleError,
  RecipeInvalidError,
  WarehouseNotConfiguredError,
  type StockAlert,
  type ConsumptionSummary,
} from './app/inventory.service.js';
export {
  InventoryEventHandlers,
  INVENTORY_CONSUMER,
} from './app/inventory-event-handlers.js';
