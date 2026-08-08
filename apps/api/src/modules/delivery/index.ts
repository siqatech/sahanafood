/** API pública del módulo Delivery (spec 09). */
export { DeliveryModule } from './delivery.module.js';
export {
  DeliveryService,
  ShipmentInvalidTransitionError,
  ShipmentAlreadyExistsError,
  type ShipmentView,
  type PublicTrackingView,
  type CourierBalance,
} from './app/delivery.service.js';
