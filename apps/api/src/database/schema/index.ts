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
