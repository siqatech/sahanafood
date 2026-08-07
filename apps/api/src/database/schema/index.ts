/**
 * Esquema Drizzle — tipos para el acceso a datos.
 *
 * La FUENTE DE VERDAD del DDL y de las políticas RLS es el SQL de
 * `infra/migrations` (la RLS necesita SQL explícito y revisable). Estas
 * definiciones Drizzle reflejan ese esquema para dar tipado a las consultas.
 * El test de esquema verifica que la BD real cumpla la convención de RLS.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  integer,
  numeric,
  doublePrecision,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// --- Plano de control (sin tenant_id) ---

export const plans = pgTable('ten_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  limits: jsonb('limits').notNull().default({}),
  features: jsonb('features').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tenants = pgTable('ten_tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  planId: uuid('plan_id').notNull(),
  country: text('country').notNull().default('PE'),
  currency: text('currency').notNull().default('PEN'),
  timezone: text('timezone').notNull().default('America/Lima'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Negocio (tenant_id + RLS) ---

export const featureFlags = pgTable(
  'ten_feature_flags',
  {
    tenantId: uuid('tenant_id').notNull(),
    flag: text('flag').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.flag] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    traceId: text('trace_id'),
    reason: text('reason'),
    data: jsonb('data').notNull().default({}),
  },
  (t) => [index('idx_audit_tenant_time').on(t.tenantId, t.occurredAt)],
);

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    traceId: text('trace_id'),
  },
  (t) => [index('idx_outbox_tenant').on(t.tenantId, t.occurredAt)],
);

export const inbox = pgTable(
  'inbox',
  {
    tenantId: uuid('tenant_id').notNull(),
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.consumer, t.eventId] })],
);

// --- Identity (módulo 02) ---

export const users = pgTable(
  'idn_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').notNull().default('active'),
    isOwner: boolean('is_owner').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_users_tenant').on(t.tenantId)],
);

export const roles = pgTable(
  'idn_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_roles_tenant').on(t.tenantId)],
);

export const rolePermissions = pgTable(
  'idn_role_permissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    roleId: uuid('role_id').notNull(),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.roleId, t.permission] })],
);

export const userRoles = pgTable(
  'idn_user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    scopeType: text('scope_type').notNull().default('tenant'),
    scopeId: uuid('scope_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_user_roles_user').on(t.tenantId, t.userId)],
);

export const sessions = pgTable(
  'idn_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    familyId: uuid('family_id').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    status: text('status').notNull().default('active'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [index('idx_sessions_user').on(t.tenantId, t.userId)],
);

// --- Organization (módulo 03) ---

export const companies = pgTable(
  'org_companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    legalName: text('legal_name').notNull(),
    taxId: text('tax_id').notNull(),
    address: text('address'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_companies_tenant').on(t.tenantId)],
);

export const brands = pgTable(
  'org_brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    domain: text('domain'),
    branding: jsonb('branding').notNull().default({}),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_brands_tenant').on(t.tenantId)],
);

export const locations = pgTable(
  'org_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    address: text('address').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    timezone: text('timezone').notNull().default('America/Lima'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_locations_tenant').on(t.tenantId)],
);

export const kitchens = pgTable(
  'org_kitchens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_kitchens_tenant').on(t.tenantId)],
);

/** Marca ⟷ Cocina: M:N (RN-ORG-01). Nunca anidar marca dentro de local. */
export const brandKitchens = pgTable(
  'org_brand_kitchens',
  {
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    kitchenId: uuid('kitchen_id').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.brandId, t.kitchenId] })],
);

export const stations = pgTable(
  'org_stations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    kitchenId: uuid('kitchen_id').notNull(),
    name: text('name').notNull(),
    /** Tipo acordado por el tenant: grill, fry, assembly, drinks... */
    kind: text('kind'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_stations_kitchen').on(t.tenantId, t.kitchenId)],
);

export const warehouses = pgTable(
  'org_warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_warehouses_tenant').on(t.tenantId)],
);

/**
 * Zona de cobertura. `deliveryFee` y `minOrder` son NUMERIC(14,4): Drizzle los
 * entrega como string para no perder precisión, y se convierten a Money en el
 * servicio. Nunca se leen como number (ADR-0006/0013).
 */
export const zones = pgTable(
  'org_zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id'),
    locationId: uuid('location_id').notNull(),
    name: text('name').notNull(),
    polygon: jsonb('polygon').notNull(),
    minLng: doublePrecision('min_lng').notNull(),
    minLat: doublePrecision('min_lat').notNull(),
    maxLng: doublePrecision('max_lng').notNull(),
    maxLat: doublePrecision('max_lat').notNull(),
    deliveryFee: numeric('delivery_fee', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    minOrder: numeric('min_order', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    baseMinutes: integer('base_minutes').notNull().default(30),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_zones_tenant_brand').on(t.tenantId, t.brandId)],
);

export const schedules = pgTable(
  'org_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id'),
    locationId: uuid('location_id').notNull(),
    channel: text('channel'),
    weekly: jsonb('weekly').notNull().default([]),
    exceptions: jsonb('exceptions').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_schedules_location').on(t.tenantId, t.locationId)],
);

// --- Dispositivos POS y PIN (módulo 02, RN-IDN-03/04) ---

export const pairingCodes = pgTable(
  'idn_pairing_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    codeHash: text('code_hash').notNull(),
    locationId: uuid('location_id'),
    createdBy: uuid('created_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    deviceId: uuid('device_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_pairing_tenant').on(t.tenantId)],
);

export const devices = pgTable(
  'idn_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    locationId: uuid('location_id'),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    status: text('status').notNull().default('active'),
    pairedAt: timestamp('paired_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [index('idx_devices_tenant').on(t.tenantId, t.status)],
);

/** PIN de operador. El bloqueo vive en BD para sobrevivir a reinicios. */
export const userPins = pgTable(
  'idn_user_pins',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    pinHash: text('pin_hash').notNull(),
    mustChange: boolean('must_change').notNull().default(true),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

// --- Catalog (módulo 04) ---

export const categories = pgTable(
  'cat_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_categories_brand').on(t.tenantId, t.brandId)],
);

export const products = pgTable(
  'cat_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    categoryId: uuid('category_id'),
    sku: text('sku'),
    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    allergens: jsonb('allergens').notNull().default([]),
    prepMinutes: integer('prep_minutes').notNull().default(10),
    /** Estación que lo prepara; NULL = estación por defecto de la cocina. */
    stationKind: text('station_kind'),
    isCombo: boolean('is_combo').notNull().default(false),
    active: boolean('active').notNull().default(true),
    rowVersion: integer('row_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_products_brand').on(t.tenantId, t.brandId)],
);

export const modifierGroups = pgTable(
  'cat_modifier_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    minSelections: integer('min_selections').notNull().default(0),
    maxSelections: integer('max_selections').notNull().default(1),
    allowRepeat: boolean('allow_repeat').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_modifier_groups_brand').on(t.tenantId, t.brandId)],
);

export const modifierOptions = pgTable(
  'cat_modifier_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    groupId: uuid('group_id').notNull(),
    name: text('name').notNull(),
    /** NUMERIC(14,4); puede ser negativo (quitar ingrediente). */
    priceDelta: numeric('price_delta', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    available: boolean('available').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('idx_modifier_options_group').on(t.tenantId, t.groupId)],
);

export const productModifierGroups = pgTable(
  'cat_product_modifier_groups',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    groupId: uuid('group_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.productId, t.groupId] })],
);

export const comboComponents = pgTable(
  'cat_combo_components',
  {
    tenantId: uuid('tenant_id').notNull(),
    comboId: uuid('combo_id').notNull(),
    componentId: uuid('component_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.comboId, t.componentId] })],
);

/** Precios por ámbito (RN-CAT-01). NUMERIC(14,4) leído como string. */
export const prices = pgTable(
  'cat_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    channel: text('channel'),
    locationId: uuid('location_id'),
    price: numeric('price', { precision: 14, scale: 4 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_prices_lookup').on(t.tenantId, t.productId)],
);

export const productPauses = pgTable(
  'cat_product_pauses',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    channel: text('channel').notNull().default('*'),
    pausedAt: timestamp('paused_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    until: timestamp('until', { withTimezone: true }),
    reason: text('reason'),
    pausedBy: uuid('paused_by'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.productId, t.channel] })],
);

// --- Ordering (módulo 05, spec canónica) ---

export const orders = pgTable(
  'ord_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    locationId: uuid('location_id').notNull(),
    orderNumber: integer('order_number').notNull(),
    channel: text('channel').notNull(),
    externalRef: text('external_ref'),
    status: text('status').notNull().default('received'),
    customerId: uuid('customer_id'),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    deliveryAddress: text('delivery_address'),
    deliveryLat: doublePrecision('delivery_lat'),
    deliveryLng: doublePrecision('delivery_lng'),
    zoneId: uuid('zone_id'),
    subtotal: numeric('subtotal', { precision: 14, scale: 4 }).notNull(),
    discountTotal: numeric('discount_total', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    deliveryFee: numeric('delivery_fee', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    tip: numeric('tip', { precision: 14, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 4 }).notNull(),
    taxableBase: numeric('taxable_base', { precision: 14, scale: 4 }).notNull(),
    tax: numeric('tax', { precision: 14, scale: 4 }).notNull(),
    taxRateBps: integer('tax_rate_bps').notNull().default(1800),
    currency: text('currency').notNull().default('PEN'),
    commissionEstimated: numeric('commission_estimated', {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default('0'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    promisedAt: timestamp('promised_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    notes: text('notes'),
    rowVersion: integer('row_version').notNull().default(1),
    acceptanceAlertedAt: timestamp('acceptance_alerted_at', {
      withTimezone: true,
    }),
    prepMinutes: integer('prep_minutes').notNull().default(15),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_orders_status').on(t.tenantId, t.status, t.createdAt)],
);

export const orderLines = pgTable(
  'ord_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id'),
    /** Snapshot: no se referencia el catálogo, se copia (RN-ORD-02). */
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    modifiersTotal: numeric('modifiers_total', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    discount: numeric('discount', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    lineTotal: numeric('line_total', { precision: 14, scale: 4 }).notNull(),
    modifiers: jsonb('modifiers').notNull().default([]),
    isAdjustment: boolean('is_adjustment').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_order_lines_order').on(t.tenantId, t.orderId)],
);

export const orderEvents = pgTable(
  'ord_order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorType: text('actor_type').notNull().default('system'),
    actorId: text('actor_id'),
    reason: text('reason'),
    traceId: text('trace_id'),
    data: jsonb('data').notNull().default({}),
  },
  (t) => [
    index('idx_order_events_order').on(t.tenantId, t.orderId, t.occurredAt),
  ],
);

export const catalogVersions = pgTable(
  'cat_catalog_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    channel: text('channel').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    checksum: text('checksum').notNull(),
    productCount: integer('product_count').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedBy: uuid('published_by'),
    notes: text('notes'),
  },
  (t) => [
    index('idx_catalog_versions_ultima').on(t.tenantId, t.brandId, t.channel),
  ],
);

export const acceptancePolicies = pgTable(
  'ord_acceptance_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    /** NULL = todas las marcas. */
    brandId: uuid('brand_id'),
    /** NULL = todos los canales. */
    channel: text('channel'),
    autoAccept: boolean('auto_accept').notNull().default(false),
    alertAfterMinutes: integer('alert_after_minutes').notNull().default(5),
    autoRejectAfterMinutes: integer('auto_reject_after_minutes')
      .notNull()
      .default(10),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_acceptance_policies_tenant').on(t.tenantId)],
);

export const orderCounters = pgTable('ord_counters', {
  tenantId: uuid('tenant_id').primaryKey(),
  nextNumber: integer('next_number').notNull().default(1),
});

export const idempotencyKeys = pgTable(
  'ord_idempotency_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    orderId: uuid('order_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

// --- Plataforma de integraciones (módulo 13) ---

export const integrationConnections = pgTable(
  'int_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    provider: text('provider').notNull(),
    brandId: uuid('brand_id').notNull(),
    locationId: uuid('location_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('active'),
    webhookToken: text('webhook_token').notNull(),
    /** Cifrado campo a campo con clave por tenant (RN-INT-04). */
    credentials: jsonb('credentials').notNull().default({}),
    config: jsonb('config').notNull().default({}),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    circuitOpenedAt: timestamp('circuit_opened_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_int_connections_tenant').on(t.tenantId, t.provider)],
);

export const integrationCatalogMap = pgTable(
  'int_catalog_map',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalSku: text('external_sku').notNull(),
    productId: uuid('product_id'),
    modifierOptionId: uuid('modifier_option_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_int_catalog_map_tenant').on(t.tenantId, t.connectionId)],
);

export const integrationWebhookEvents = pgTable(
  'int_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    provider: text('provider').notNull(),
    deliveryId: text('delivery_id').notNull(),
    externalRef: text('external_ref'),
    eventType: text('event_type').notNull().default('order.created'),
    payload: jsonb('payload').notNull(),
    headers: jsonb('headers').notNull().default({}),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    orderId: uuid('order_id'),
    traceId: text('trace_id'),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [index('idx_int_webhook_tenant').on(t.tenantId, t.receivedAt)],
);

// --- Cocina / KDS (módulo 07) ---

export const kitchenTickets = pgTable(
  'kit_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    kitchenId: uuid('kitchen_id').notNull(),
    stationId: uuid('station_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    status: text('status').notNull().default('pending'),
    orderNumber: integer('order_number').notNull(),
    promisedAt: timestamp('promised_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    rowVersion: integer('row_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_tickets_order').on(t.tenantId, t.orderId)],
);

export const kitchenTicketLines = pgTable(
  'kit_ticket_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    orderLineId: uuid('order_line_id'),
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    modifiersText: text('modifiers_text'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_ticket_lines_ticket').on(t.tenantId, t.ticketId)],
);
