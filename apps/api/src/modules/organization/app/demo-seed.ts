import { boundingBox, type Ring } from '@sahana/domain';
import type { TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';

/**
 * Semilla demo de organización — criterio de aceptación de la spec 03:
 * «1 tenant, 1 empresa, 2 marcas, 1 local, 1 cocina COMPARTIDA, 3 estaciones,
 * 2 zonas — usada por todos los E2E».
 *
 * La cocina compartida entre dos marcas no es un detalle de la demo: es el
 * modelo de negocio de una dark kitchen y ejercita el M:N (RN-ORG-01) desde el
 * primer día, de modo que ningún módulo posterior pueda asumir 1:1.
 *
 * Geografía: dos zonas de Lima que **se solapan a propósito**, para que los
 * E2E ejerciten la regla «gana la de menor tarifa» (RN-ORG-02).
 */

/** Zona amplia (Miraflores–Barranco): más cara, cubre todo. */
const ZONA_AMPLIA: Ring = [
  [-77.05, -12.16],
  [-77.05, -12.1],
  [-76.97, -12.1],
  [-76.97, -12.16],
];

/** Zona céntrica: más barata y contenida dentro de la amplia. */
const ZONA_CENTRICA: Ring = [
  [-77.04, -12.14],
  [-77.04, -12.11],
  [-77.0, -12.11],
  [-77.0, -12.14],
];

export interface DemoOrganization {
  companyId: string;
  brandIds: [string, string];
  locationId: string;
  kitchenId: string;
  stationIds: string[];
  zoneIds: [string, string];
  warehouseId: string;
  scheduleId: string;
}

/** Crea la organización demo dentro de la transacción del tenant. */
export async function seedDemoOrganization(
  ctx: TenantContext,
): Promise<DemoOrganization> {
  const tenantId = ctx.tenantId;

  const [company] = await ctx.db
    .insert(schema.companies)
    .values({
      tenantId,
      legalName: 'Sahana Demo Alimentos S.A.C.',
      taxId: '20123456789',
      address: 'Av. Demo 123, Lima',
    })
    .returning({ id: schema.companies.id });
  const companyId = company!.id;

  // Dos marcas de la MISMA empresa que comparten cocina.
  const brandRows = await ctx.db
    .insert(schema.brands)
    .values([
      {
        tenantId,
        companyId,
        name: 'Pollería El Buen Sabor',
        slug: 'buen-sabor',
        branding: { primaryColor: '#C8102E' },
      },
      {
        tenantId,
        companyId,
        name: 'Wok Express',
        slug: 'wok-express',
        branding: { primaryColor: '#0F7B6C' },
      },
    ])
    .returning({ id: schema.brands.id });
  const brandIds: [string, string] = [brandRows[0]!.id, brandRows[1]!.id];

  const [location] = await ctx.db
    .insert(schema.locations)
    .values({
      tenantId,
      companyId,
      name: 'Local Miraflores',
      address: 'Av. Larco 456, Miraflores, Lima',
      lat: -12.12,
      lng: -77.03,
      timezone: 'America/Lima',
    })
    .returning({ id: schema.locations.id });
  const locationId = location!.id;

  // UNA cocina para las DOS marcas: el caso M:N del modelo dark kitchen.
  const [kitchen] = await ctx.db
    .insert(schema.kitchens)
    .values({ tenantId, locationId, name: 'Cocina Central' })
    .returning({ id: schema.kitchens.id });
  const kitchenId = kitchen!.id;

  await ctx.db.insert(schema.brandKitchens).values([
    { tenantId, brandId: brandIds[0], kitchenId },
    { tenantId, brandId: brandIds[1], kitchenId },
  ]);

  const stationRows = await ctx.db
    .insert(schema.stations)
    .values([
      { tenantId, kitchenId, name: 'Parrilla', sortOrder: 1 },
      { tenantId, kitchenId, name: 'Frituras', sortOrder: 2 },
      { tenantId, kitchenId, name: 'Armado y empaque', sortOrder: 3 },
    ])
    .returning({ id: schema.stations.id });

  const [warehouse] = await ctx.db
    .insert(schema.warehouses)
    .values({ tenantId, locationId, name: 'Almacén Miraflores' })
    .returning({ id: schema.warehouses.id });

  // Zonas solapadas: la céntrica es más barata y debe ganar donde coincidan.
  const amplia = boundingBox(ZONA_AMPLIA);
  const centrica = boundingBox(ZONA_CENTRICA);
  const zoneRows = await ctx.db
    .insert(schema.zones)
    .values([
      {
        tenantId,
        locationId,
        brandId: null, // aplica a todas las marcas
        name: 'Zona amplia',
        polygon: ZONA_AMPLIA as unknown as number[][],
        minLng: amplia.minLng,
        minLat: amplia.minLat,
        maxLng: amplia.maxLng,
        maxLat: amplia.maxLat,
        deliveryFee: '8.5000', // S/ 8.50
        minOrder: '25.0000',
        baseMinutes: 45,
      },
      {
        tenantId,
        locationId,
        brandId: null,
        name: 'Zona céntrica',
        polygon: ZONA_CENTRICA as unknown as number[][],
        minLng: centrica.minLng,
        minLat: centrica.minLat,
        maxLng: centrica.maxLng,
        maxLat: centrica.maxLat,
        deliveryFee: '5.0000', // S/ 5.00 — más barata: gana en el solapamiento
        minOrder: '20.0000',
        baseMinutes: 30,
      },
    ])
    .returning({ id: schema.zones.id });

  // Horario con turno nocturno que cruza medianoche (viernes y sábado).
  const [scheduleRow] = await ctx.db
    .insert(schema.schedules)
    .values({
      tenantId,
      locationId,
      brandId: null,
      channel: null,
      weekly: [
        { weekday: 1, opensAt: '11:00', closesAt: '23:00' },
        { weekday: 2, opensAt: '11:00', closesAt: '23:00' },
        { weekday: 3, opensAt: '11:00', closesAt: '23:00' },
        { weekday: 4, opensAt: '11:00', closesAt: '23:00' },
        { weekday: 5, opensAt: '11:00', closesAt: '02:00' }, // cruza medianoche
        { weekday: 6, opensAt: '11:00', closesAt: '02:00' }, // cruza medianoche
        { weekday: 0, opensAt: '11:00', closesAt: '22:00' },
      ],
      exceptions: [
        // Fiestas Patrias: cerrado.
        { date: '2026-07-28', ranges: [] },
      ],
    })
    .returning({ id: schema.schedules.id });

  return {
    companyId,
    brandIds,
    locationId,
    kitchenId,
    stationIds: stationRows.map((s) => s.id),
    zoneIds: [zoneRows[0]!.id, zoneRows[1]!.id],
    warehouseId: warehouse!.id,
    scheduleId: scheduleRow!.id,
  };
}
