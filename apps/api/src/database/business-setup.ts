import { OrganizationAdminService } from '../modules/organization/index.js';
import { CatalogAdminService } from '../modules/catalog/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import type { Ring, Schedule, WeeklySlot } from '@sahana/domain';

/**
 * Aplicación de la configuración de un negocio descrita en un archivo.
 *
 * Aquí vive la lógica; el envoltorio de línea de comandos está en
 * `setup-business.ts`. Están separados para que esto se pueda **ejecutar en una
 * prueba** contra `infra/ejemplos/negocio.ejemplo.json`: un runbook que promete
 * un comando y un ejemplo que nadie ha corrido es exactamente cómo se llega al
 * día del despliegue con un archivo que no aplica.
 *
 * Existe por dos razones que no son la misma:
 *
 * 1. **No hay panel** (DT-09). Sin él, un cliente recién dado de alta con
 *    `provision.js` tiene cuenta pero no tiene negocio: ni marca, ni local, ni
 *    zona de reparto, ni carta. La API de escritura ya existe; lo que faltaba
 *    era una forma de usarla sin escribir veinte `curl` a mano.
 *
 * 2. **Dar de alta a diez clientes tiene que ser repetible.** Un negocio
 *    descrito en un archivo se revisa, se versiona y se vuelve a aplicar. Es la
 *    diferencia entre configurar un cliente y poder configurar clientes.
 *
 * Todo lo que invoca es idempotente por clave natural, así que **volver a
 * aplicar el mismo archivo con la carta cambiada** actualiza precios y añade
 * productos nuevos sin duplicar nada. Ese es el caso real: no el alta, sino la
 * corrección del viernes.
 *
 * Lo que NO hace: crear el tenant (eso es `provision.js`) ni verificar el DNS
 * de verdad. Marca el dominio como verificado porque quien ejecuta esto tiene
 * acceso al servidor; la comprobación real del CNAME llega con T3.16.
 */

export interface DescripcionNegocio {
  empresa: {
    razonSocial: string;
    ruc: string;
    direccion?: string;
  };
  marcas: Array<{
    nombre: string;
    slug?: string;
    /** Dominio de la tienda de esta marca. Se registra y se da por verificado. */
    tienda?: { host: string; esSubdominio?: boolean };
  }>;
  locales: Array<{
    nombre: string;
    direccion: string;
    lat?: number;
    lng?: number;
    zonaHoraria?: string;
    cocinas?: Array<{
      nombre: string;
      /** Marcas que se producen en esta cocina (por nombre o slug). */
      marcas?: string[];
      estaciones?: Array<{ nombre: string; orden?: number }>;
    }>;
    zonas?: Array<{
      nombre: string;
      marca?: string;
      poligono: Array<[number, number]>;
      /** Importes en soles como cadena decimal: «5.00», nunca 5.0 en coma flotante. */
      tarifaEnvio?: string;
      pedidoMinimo?: string;
      minutosBase?: number;
    }>;
    horarios?: Array<{
      marca?: string;
      canal?: string;
      semanal: Array<{ weekday: number; opensAt: string; closesAt: string }>;
      excepciones?: Schedule['exceptions'];
    }>;
  }>;
  carta?: Array<{
    /** Marca a la que pertenece esta carta (por nombre o slug). */
    marca: string;
    categorias?: Array<{ nombre: string; orden?: number }>;
    gruposModificadores?: Array<{
      nombre: string;
      min?: number;
      max?: number;
      permiteRepetir?: boolean;
      opciones: Array<{ nombre: string; delta?: string; disponible?: boolean }>;
    }>;
    productos: Array<{
      sku?: string;
      nombre: string;
      descripcion?: string;
      categoria?: string;
      imagen?: string;
      alergenos?: string[];
      minutosPreparacion?: number;
      esCombo?: boolean;
      /** Componentes de un combo, por SKU o nombre. */
      componentes?: Array<{ producto: string; cantidad: number }>;
      modificadores?: string[];
      /**
       * Precios por canal. La clave es el canal (`web`, `pos`, `rappi`…) o
       * `base` para el precio que sirve a cualquier canal sin uno propio.
       */
      precios: Record<string, string>;
    }>;
  }>;
}

/**
 * Soles como cadena decimal → unidades menores a escala 4.
 *
 * Se hace aquí y con enteros porque el archivo lo escribe una persona en soles
 * («12.50») y el resto del sistema trabaja en unidades menores. Pasar por
 * `Number` sería meter coma flotante en la única cifra que no la admite: el
 * precio que paga el cliente.
 */
export function aUnidadesMenores(valor: string, donde: string): number {
  const limpio = valor.trim();
  const m = /^(-)?(\d+)(?:[.,](\d{1,4}))?$/.exec(limpio);
  if (!m) {
    throw new Error(
      `${donde}: "${valor}" no es un importe válido. Escríbelo como "12.50".`,
    );
  }
  const enteros = m[2]!;
  const decimales = (m[3] ?? '').padEnd(4, '0');
  const magnitud = Number(`${enteros}${decimales}`);
  return m[1] === '-' ? -magnitud : magnitud;
}

/** Servicios que hacen falta para aplicar un negocio. */
export interface ServiciosDeAlta {
  org: OrganizationAdminService;
  carta: CatalogAdminService;
  tienda: StorefrontService;
}

/**
 * Cuentas de lo aplicado. Los campos se llaman `…Count` y no `prices`,
 * `products`… porque la regla de ESLint que prohíbe tipar dinero como `number`
 * mira el NOMBRE del campo, y tiene razón en desconfiar: un `prices: number`
 * es indistinguible a simple vista de un importe mal modelado. Aquí son
 * cuentas, y el nombre lo dice.
 */
export interface ResumenDeAlta {
  companyId: string;
  brandCount: number;
  locationCount: number;
  productCount: number;
  priceCount: number;
}

/**
 * Aplica la descripción sobre un tenant que YA existe (`provision.js`).
 *
 * Todo lo que invoca es idempotente por clave natural, así que volver a aplicar
 * el mismo archivo con la carta cambiada actualiza precios y añade productos
 * nuevos sin duplicar nada. Ese es el caso real: no el alta, sino la corrección
 * del viernes.
 */
export async function aplicarNegocio(
  servicios: ServiciosDeAlta,
  tenantId: string,
  negocio: DescripcionNegocio,
  paso: (texto: string) => void = () => {},
): Promise<ResumenDeAlta> {
  const { org, carta, tienda } = servicios;

  // ------------------------------------------------------------- Empresa
  const empresa = await org.upsertCompany(tenantId, {
    legalName: negocio.empresa.razonSocial,
    taxId: negocio.empresa.ruc,
    ...(negocio.empresa.direccion !== undefined
      ? { address: negocio.empresa.direccion }
      : {}),
  });
  paso(`Empresa: ${empresa.legalName} (RUC ${empresa.taxId})`);

  // -------------------------------------------------------------- Marcas
  // El índice se llena con NOMBRE y SLUG: el archivo puede referirse a una
  // marca de las dos formas y ninguna es más «correcta» que la otra para
  // quien lo escribe.
  const marcas = new Map<string, string>();
  for (const m of negocio.marcas) {
    const marca = await org.upsertBrand(tenantId, {
      companyId: empresa.id,
      name: m.nombre,
      ...(m.slug !== undefined ? { slug: m.slug } : {}),
    });
    marcas.set(m.nombre.toLowerCase(), marca.id);
    marcas.set(marca.slug, marca.id);
    paso(`Marca: ${marca.name} (${marca.slug})`);

    if (m.tienda) {
      const dominio = await tienda.ensureDomain(tenantId, {
        brandId: marca.id,
        host: m.tienda.host,
        ...(m.tienda.esSubdominio !== undefined
          ? { isSubdomain: m.tienda.esSubdominio }
          : {}),
        verified: true,
      });
      paso(`  Tienda en ${dominio.host} (${dominio.status})`);
    }
  }

  const exigeMarca = (nombre: string, donde: string): string => {
    const id = marcas.get(nombre.toLowerCase());
    if (!id) {
      throw new Error(
        `${donde}: la marca "${nombre}" no está en la lista de marcas del archivo.`,
      );
    }
    return id;
  };

  // ------------------------------------------------------------- Locales
  for (const l of negocio.locales) {
    const local = await org.upsertLocation(tenantId, {
      companyId: empresa.id,
      name: l.nombre,
      address: l.direccion,
      ...(l.lat !== undefined ? { lat: l.lat } : {}),
      ...(l.lng !== undefined ? { lng: l.lng } : {}),
      ...(l.zonaHoraria !== undefined ? { timezone: l.zonaHoraria } : {}),
    });
    paso(`Local: ${local.name}`);

    for (const c of l.cocinas ?? []) {
      const cocina = await org.upsertKitchen(tenantId, {
        locationId: local.id,
        name: c.nombre,
      });
      for (const nombreMarca of c.marcas ?? []) {
        await org.linkBrandKitchen(tenantId, {
          brandId: exigeMarca(nombreMarca, `cocina "${c.nombre}"`),
          kitchenId: cocina.id,
        });
      }
      for (const e of c.estaciones ?? []) {
        await org.upsertStation(tenantId, {
          kitchenId: cocina.id,
          name: e.nombre,
          ...(e.orden !== undefined ? { sortOrder: e.orden } : {}),
        });
      }
      paso(
        `  Cocina: ${cocina.name} — ${(c.marcas ?? []).length} marca(s), ${(c.estaciones ?? []).length} estación(es)`,
      );
    }

    for (const z of l.zonas ?? []) {
      const zona = await org.upsertZone(tenantId, {
        locationId: local.id,
        name: z.nombre,
        polygon: z.poligono as unknown as Ring,
        ...(z.marca !== undefined
          ? { brandId: exigeMarca(z.marca, `zona "${z.nombre}"`) }
          : {}),
        ...(z.tarifaEnvio !== undefined
          ? {
              deliveryFeeMinor: aUnidadesMenores(
                z.tarifaEnvio,
                `zona "${z.nombre}" (tarifaEnvio)`,
              ),
            }
          : {}),
        ...(z.pedidoMinimo !== undefined
          ? {
              minOrderMinor: aUnidadesMenores(
                z.pedidoMinimo,
                `zona "${z.nombre}" (pedidoMinimo)`,
              ),
            }
          : {}),
        ...(z.minutosBase !== undefined ? { baseMinutes: z.minutosBase } : {}),
      });
      paso(`  Zona: ${zona.name} — envío ${zona.deliveryFee}`);
    }

    for (const h of l.horarios ?? []) {
      await org.upsertSchedule(tenantId, {
        locationId: local.id,
        ...(h.marca !== undefined
          ? { brandId: exigeMarca(h.marca, `horario de "${l.nombre}"`) }
          : {}),
        ...(h.canal !== undefined ? { channel: h.canal } : {}),
        schedule: {
          // El día se comprueba aquí: viene de un archivo escrito a mano y un
          // 7 —lunes contado desde 1— guardaría un tramo que el evaluador de
          // horarios nunca casa. El local aparecería cerrado y nada fallaría.
          weekly: h.semanal.map((slot) => {
            if (
              !Number.isInteger(slot.weekday) ||
              slot.weekday < 0 ||
              slot.weekday > 6
            ) {
              throw new Error(
                `horario de "${l.nombre}": weekday ${slot.weekday} no existe. Es 0 (domingo) a 6 (sábado).`,
              );
            }
            return { ...slot, weekday: slot.weekday as WeeklySlot['weekday'] };
          }),
          ...(h.excepciones !== undefined ? { exceptions: h.excepciones } : {}),
        },
      });
      paso(`  Horario: ${h.semanal.length} tramo(s)`);
    }
  }

  // --------------------------------------------------------------- Carta
  let productosCreados = 0;
  let preciosPuestos = 0;
  for (const c of negocio.carta ?? []) {
    const brandId = exigeMarca(c.marca, 'carta');

    const categorias = new Map<string, string>();
    for (const cat of c.categorias ?? []) {
      const creada = await carta.upsertCategory(tenantId, {
        brandId,
        name: cat.nombre,
        ...(cat.orden !== undefined ? { sortOrder: cat.orden } : {}),
      });
      categorias.set(cat.nombre.toLowerCase(), creada.id);
    }

    const grupos = new Map<string, string>();
    for (const g of c.gruposModificadores ?? []) {
      const grupo = await carta.upsertModifierGroup(tenantId, {
        brandId,
        name: g.nombre,
        ...(g.min !== undefined ? { minSelections: g.min } : {}),
        ...(g.max !== undefined ? { maxSelections: g.max } : {}),
        ...(g.permiteRepetir !== undefined
          ? { allowRepeat: g.permiteRepetir }
          : {}),
      });
      grupos.set(g.nombre.toLowerCase(), grupo.id);
      for (const [i, o] of g.opciones.entries()) {
        await carta.upsertModifierOption(tenantId, {
          groupId: grupo.id,
          name: o.nombre,
          ...(o.delta !== undefined
            ? {
                priceDeltaMinor: aUnidadesMenores(
                  o.delta,
                  `opción "${o.nombre}" de "${g.nombre}"`,
                ),
              }
            : {}),
          ...(o.disponible !== undefined ? { available: o.disponible } : {}),
          sortOrder: i,
        });
      }
    }

    // Dos pasadas por los productos: primero todos, y los componentes de los
    // combos después. Un combo puede nombrar un producto que aparece más
    // abajo en el archivo, y el orden de la lista no debería importarle a
    // quien la escribe.
    const productos = new Map<string, string>();
    for (const p of c.productos) {
      const creado = await carta.upsertProduct(tenantId, {
        brandId,
        name: p.nombre,
        ...(p.sku !== undefined ? { sku: p.sku } : {}),
        ...(p.descripcion !== undefined ? { description: p.descripcion } : {}),
        ...(p.imagen !== undefined ? { imageUrl: p.imagen } : {}),
        ...(p.alergenos !== undefined ? { allergens: p.alergenos } : {}),
        ...(p.minutosPreparacion !== undefined
          ? { prepMinutes: p.minutosPreparacion }
          : {}),
        ...(p.esCombo !== undefined ? { isCombo: p.esCombo } : {}),
        ...(p.categoria !== undefined
          ? {
              categoryId:
                categorias.get(p.categoria.toLowerCase()) ??
                (() => {
                  throw new Error(
                    `producto "${p.nombre}": la categoría "${p.categoria}" no está declarada en esta carta.`,
                  );
                })(),
            }
          : {}),
      });
      productosCreados += 1;
      productos.set(p.nombre.toLowerCase(), creado.id);
      if (p.sku) productos.set(p.sku.toLowerCase(), creado.id);

      for (const [canal, importe] of Object.entries(p.precios)) {
        await carta.setPrice(tenantId, {
          productId: creado.id,
          // `base` es el precio que sirve a cualquier canal sin uno propio,
          // y en la base eso se representa con `channel` nulo.
          ...(canal === 'base' ? {} : { channel: canal }),
          priceMinor: aUnidadesMenores(
            importe,
            `precio "${canal}" de "${p.nombre}"`,
          ),
        });
        preciosPuestos += 1;
      }

      for (const nombreGrupo of p.modificadores ?? []) {
        const groupId = grupos.get(nombreGrupo.toLowerCase());
        if (!groupId) {
          throw new Error(
            `producto "${p.nombre}": el grupo "${nombreGrupo}" no está declarado en esta carta.`,
          );
        }
        await carta.linkProductModifierGroup(tenantId, {
          productId: creado.id,
          groupId,
        });
      }
    }

    for (const p of c.productos) {
      if (!p.componentes?.length) continue;
      const comboId = productos.get((p.sku ?? p.nombre).toLowerCase())!;
      await carta.setComboComponents(tenantId, {
        comboId,
        components: p.componentes.map((comp) => {
          const productId = productos.get(comp.producto.toLowerCase());
          if (!productId) {
            throw new Error(
              `combo "${p.nombre}": el componente "${comp.producto}" no está en esta carta.`,
            );
          }
          return { productId, quantity: comp.cantidad };
        }),
      });
    }

    paso(
      `Carta de ${c.marca}: ${c.productos.length} producto(s), ${(c.categorias ?? []).length} categoría(s)`,
    );
  }

  return {
    companyId: empresa.id,
    brandCount: negocio.marcas.length,
    locationCount: negocio.locales.length,
    productCount: productosCreados,
    priceCount: preciosPuestos,
  };
}
