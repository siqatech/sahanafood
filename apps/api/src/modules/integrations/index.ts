/**
 * API pública del módulo Integrations (spec 13).
 *
 * Lo que sale de aquí es la frontera con los marketplaces. `ChannelConnector`
 * es lo único que un conector nuevo (F7: Rappi, PedidosYa) necesita implementar
 * para entrar en el sistema sin tocar la ingesta ni el orquestador.
 */
export { IntegrationsModule } from './integrations.module.js';
export {
  ConnectionService,
  SIGNING_SECRET_FIELD,
  type ConnectionView,
  type ResolvedConnection,
} from './app/connection.service.js';
export {
  IngestionService,
  WebhookSignatureError,
  WebhookConnectionError,
  WebhookConnectionPausedError,
  MAX_INGESTION_ATTEMPTS,
  type AckResult,
  type ProcessResult,
} from './app/ingestion.service.js';
export {
  ChannelSyncService,
  type ResultadoDePropagacion,
} from './app/channel-sync.service.js';
export {
  IntegrationsEventHandlers,
  INTEGRATIONS_CONSUMER,
} from './app/integrations-event-handlers.js';
export {
  ConnectorParseError,
  type ChannelConnector,
  type NormalizedOrder,
  type NormalizedOrderLine,
  type WebhookHeaders,
  type WebhookIdentity,
} from './domain/channel-connector.js';
export {
  circuitState,
  circuitAllows,
  afterAttempt,
  CircuitOpenError,
  DEFAULT_CIRCUIT_POLICY,
  type CircuitPolicy,
  type CircuitSnapshot,
  type CircuitState,
} from './domain/circuit-breaker.js';
export {
  CredentialCipher,
  CredentialCipherError,
  redactCredentials,
  safeEqual,
  isEncryptedField,
  type EncryptedField,
} from './app/credential-cipher.js';
export {
  SimulatorConnector,
  SIMULATOR_PROVIDER,
  SIGNATURE_HEADER,
  DELIVERY_HEADER,
  signSimulatorPayload,
  type SimulatorPayload,
} from './app/connectors/simulator.connector.js';
export {
  MarketplaceSimulator,
  type SimulatorScenario,
  type SimulatedDelivery,
  type GeneratorOptions,
} from './app/connectors/simulator.generator.js';
