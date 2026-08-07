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
