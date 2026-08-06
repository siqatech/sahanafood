# Modelo de datos inicial

Tablas núcleo (prefijo por módulo). Tipos: PK `ulid` (char(26)), dinero `NUMERIC(14,4)`, timestamps `timestamptz`.

## organization
- `org_companies(id, tenant_id, ruc, legal_name, tax_config, tz)`
- `org_brands(id, tenant_id, company_id, name, slug, branding jsonb)`
- `org_locations(id, tenant_id, name, address, geo point, tz)`
- `org_kitchens(id, tenant_id, location_id, name)`
- `org_brand_kitchen(tenant_id, brand_id, kitchen_id)` — M:N
- `org_stations(id, tenant_id, kitchen_id, name, kind)`
- `org_delivery_zones(id, tenant_id, location_id, polygon geography, fee, min_order)`

## catalog
- `cat_categories`, `cat_products(id, tenant_id, brand_id, name, base_price, tax_class, station_kind, recipe_id?)`
- `cat_variants`, `cat_modifier_groups`, `cat_modifiers`, `cat_combos`, `cat_combo_items`
- `cat_price_lists(id, tenant_id, brand_id, channel, location_id?)` + `cat_prices(price_list_id, product_id/variant_id, amount)`
- `cat_availability(product_id, channel, location_id, schedule jsonb, is_paused, paused_until)`

## ordering
- `ord_orders(id, tenant_id, brand_id, kitchen_id, location_id, channel, external_ref, status, promised_at, scheduled_at?, totals jsonb, customer_snapshot jsonb, source_snapshot jsonb, row_version)`
  - UNIQUE `(tenant_id, channel, external_ref)` — deduplicación
- `ord_order_lines(id, tenant_id, order_id, product_snapshot jsonb, qty, unit_price, modifiers jsonb, line_total, station_id?)`
- `ord_order_events(id, tenant_id, order_id, from_status, to_status, actor, reason, at)` — historial completo
- `ord_idempotency_keys(tenant_id, key, request_hash, response, expires_at)` — TTL 48 h

## kitchen
- `kit_tickets(id, tenant_id, order_id, station_id, status, started_at, ready_at)`
- `kit_capacity(kitchen_id, max_concurrent_items, thresholds jsonb)`

## inventory
- `inv_items(id, tenant_id, name, uom, cost_method='avg', current_cost)`
- `inv_recipes(id, tenant_id, product_id, yields)` + `inv_recipe_lines(recipe_id, item_id|subrecipe_id, qty, waste_pct)`
- `inv_warehouses(id, tenant_id, location_id, shared bool)`
- `inv_movements(id, tenant_id, warehouse_id, item_id, kind[sale|purchase|waste|transfer|adjust|production], qty, unit_cost, ref_type, ref_id, at)` — kardex append-only
- `inv_stock(warehouse_id, item_id, qty)` — materializado, puede ser negativo (RN-T07) con alerta

## payments/billing
- `pay_cash_sessions(id, tenant_id, location_id, opened_by, opened_at, closed_at, declared jsonb, counted jsonb, diff)`
- `pay_payments(id, tenant_id, order_id, method, amount, gateway_ref, status)`
- `pay_documents(id, tenant_id, company_id, order_id, kind[boleta|factura|nc], series, number, ose_status, ose_ticket, xml_url, pdf_url, queued_offline bool)`
- `pay_channel_fees(tenant_id, channel, order_id, estimated, settled?, settled_at?)`

## plataforma
- `outbox(id, tenant_id, aggregate, aggregate_id, event_type, payload jsonb, occurred_at, published_at?)`
- `inbox(consumer, event_id, processed_at)` PK `(consumer, event_id)`
- `audit_log(id, tenant_id, actor, action, entity, entity_id, before jsonb, after jsonb, reason, ip, at)` — append-only
- `int_connections(id, tenant_id, provider, credentials_encrypted, status, config jsonb)`
- `int_catalog_mappings(connection_id, internal_id, external_id, kind)`

Índices y particiones: ver docs/09 y docs/15.
