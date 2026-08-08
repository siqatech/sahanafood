#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

/**
 * `pg` se resuelve desde `apps/api`, que es quien lo declara.
 *
 * Node busca los imports desde la carpeta del FICHERO, no desde el cwd, y pnpm
 * no eleva dependencias al `node_modules` de la raíz. Un `import pg from 'pg'`
 * aquí falla siempre, corras desde donde corras.
 */
const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const pg = require('pg');

/**
 * Verificación de CERO PÉRDIDA tras la prueba de carga (T4.30).
 *
 * Es la mitad que convierte un benchmark en una prueba. k6 mide latencia y
 * cuenta respuestas, pero no sabe si esas respuestas se convirtieron en algo:
 * una API puede devolver 201 a cinco mil pedidos y haber perdido cien por el
 * camino —una transacción abortada, un evento que nunca salió del outbox— y
 * los percentiles saldrían preciosos.
 *
 * El criterio de la spec es literal: **outbox = pedidos, DLQ = 0**. Aquí se
 * comprueba contra la base de datos, que es la única fuente que no miente.
 *
 * Se ejecuta DESPUÉS de la carga y con el worker corriendo: hay que darle
 * tiempo a drenar. Un outbox con cosas pendientes no es pérdida —es trabajo en
 * curso— y por eso se espera antes de juzgar.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const RESUMEN =
  process.env.SUMMARY ??
  new URL('results/submit-orders.json', import.meta.url).pathname;
/** Cuánto esperar a que el relay drene antes de dar por perdido lo pendiente. */
const ESPERA_DRENAJE_MS = Number(process.env.DRAIN_TIMEOUT_MS ?? 120_000);

if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

/**
 * Consulta con contexto de sistema.
 *
 * El escape `app.system` SOLO abre outbox/inbox y el catálogo de tenants: son
 * tablas de plataforma. Las tablas de negocio NO lo tienen —a propósito, ver
 * 0003— así que aquí sirve para la búsqueda del tenant y poco más.
 *
 * OJO con los parámetros: `pg` manda los strings de JavaScript como `text`, y
 * `tenant_id` es `uuid`. Postgres no compara ambos tipos —«operator does not
 * exist: text = uuid»— así que TODA comparación con el id lleva `$n::uuid`.
 */
function sistema(sql, params = []) {
  return enTransaccion(
    (client) => client.query("SELECT set_config('app.system', 'on', true)"),
    sql,
    params,
  );
}

/**
 * Consulta con el contexto de tenant que exige la RLS.
 *
 * Es la forma de leer tablas de negocio, y la primera versión de este guion no
 * la tenía: contaba `ord_orders` bajo `app.system` y obtenía CERO. Cero pedidos
 * y cero eventos pendientes daban todos los criterios en verde salvo uno —una
 * verificación que se aprueba a sí misma mirando una tabla vacía es peor que no
 * tenerla, porque da confianza falsa.
 */
function comoTenant(tenantId, sql, params = []) {
  return enTransaccion(
    (client) =>
      client.query('SELECT set_config($1, $2, true)', [
        'app.tenant_id',
        tenantId,
      ]),
    sql,
    params,
  );
}

async function enTransaccion(preparar, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await preparar(client);
    const r = await client.query(sql, params);
    await client.query('COMMIT');
    return r.rows;
  } finally {
    client.release();
  }
}

async function tenantDeCarga() {
  const rows = await sistema(
    `SELECT id FROM ten_tenants WHERE name = 'Carga — Escenario k6'`,
  );
  if (!rows[0]) {
    console.error(
      'No existe el tenant de carga. Ejecuta antes: make load-seed',
    );
    process.exit(1);
  }
  return rows[0].id;
}

/**
 * Espera a que el outbox se vacíe.
 *
 * Sin esta espera, la verificación correría justo después del pico y contaría
 * como «perdidos» eventos que el relay simplemente no había alcanzado todavía.
 * Eso convertiría una prueba en un generador de falsas alarmas, y una prueba
 * que da falsas alarmas se acaba ignorando.
 */
async function esperarDrenaje(tenantId) {
  const limite = Date.now() + ESPERA_DRENAJE_MS;
  let pendientes = Infinity;
  let ultimoAviso = 0;

  while (Date.now() < limite) {
    // Dos colas, no una: el outbox (eventos que salen) y los webhooks
    // recibidos (pedidos que entran). Esperar solo por la primera daría por
    // buena una ingesta a medio procesar.
    const [fila] = await comoTenant(
      tenantId,
      `SELECT (SELECT count(*) FROM outbox
                WHERE tenant_id = $1::uuid AND published_at IS NULL)
            + (SELECT count(*) FROM int_webhook_events
                WHERE tenant_id = $1::uuid AND status = 'pending')
              AS n`,
      [tenantId],
    );
    pendientes = Number(fila.n);
    if (pendientes === 0) return { drenado: true, pendientes: 0 };

    if (Date.now() - ultimoAviso > 10_000) {
      console.log(`  … esperando a los relays: ${pendientes} pendientes`);
      ultimoAviso = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  return { drenado: false, pendientes };
}

async function main() {
  const tenantId = await tenantDeCarga();

  let resumen = null;
  try {
    resumen = JSON.parse(await readFile(RESUMEN, 'utf8'));
  } catch {
    console.log(
      `(sin resumen de k6 en ${RESUMEN}: se verifica solo contra la base)`,
    );
  }

  const creadosPorK6 = resumen?.metrics?.pedidos_creados?.values?.count ?? null;

  console.log('\n=== Verificación de cero pérdida (T4.30) ===\n');

  console.log('Esperando a que el relay drene el outbox…');
  const drenaje = await esperarDrenaje(tenantId);

  const [pedidos] = await comoTenant(
    tenantId,
    `SELECT count(*)::int AS n FROM ord_orders WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const [eventos] = await comoTenant(
    tenantId,
    `SELECT count(*)::int AS n FROM outbox
      WHERE tenant_id = $1::uuid AND aggregate_type = 'order'
        AND event_type IN ('order.submitted','order.accepted')`,
    [tenantId],
  );
  const [muertos] = await comoTenant(
    tenantId,
    // Un evento con intentos agotados es la cola de muertos de este diseño:
    // no hay tabla DLQ aparte porque el outbox ES la cola (ADR-0007).
    `SELECT count(*)::int AS n FROM outbox
      WHERE tenant_id = $1::uuid AND published_at IS NULL AND attempts >= 5`,
    [tenantId],
  );
  const [sinEvento] = await comoTenant(
    tenantId,
    `SELECT count(*)::int AS n FROM ord_orders o
      WHERE o.tenant_id = $1::uuid
        AND NOT EXISTS (
          SELECT 1 FROM outbox e
           -- aggregate_id es text (el outbox sirve a agregados cuyo id tiene
           -- cualquier forma) y ord_orders.id es uuid: sin el cast Postgres no
           -- encuentra el operador y la comprobación revienta.
           WHERE e.tenant_id = o.tenant_id AND e.aggregate_id = o.id::text
        )`,
    [tenantId],
  );

  // El outbox limpio prueba que el evento SALIÓ; no prueba que alguien lo
  // atendiera. Bajo carga, el consumidor es tan capaz de perder trabajo como el
  // productor, y un pedido aceptado que no llegó a la cocina es una pérdida
  // aunque todas las tablas de eventos estén impecables.
  const [sinTicket] = await comoTenant(
    tenantId,
    `SELECT count(*)::int AS n FROM ord_orders o
      WHERE o.tenant_id = $1::uuid
        AND o.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM kit_tickets t
           WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id
        )`,
    [tenantId],
  );

  // Lo que entró por webhook. `status='done'` ya implica pedido por CHECK en la
  // tabla, así que lo único que puede haberse perdido es lo que quedó en
  // 'failed' —el payload sigue guardado, pero nadie lo ha convertido en nada.
  const [ingesta] = await comoTenant(
    tenantId,
    `SELECT
       count(*) FILTER (WHERE status = 'done')::int    AS hechos,
       count(*) FILTER (WHERE status = 'failed')::int  AS fallidos,
       count(*) FILTER (WHERE status = 'pending')::int AS pendientes
     FROM int_webhook_events WHERE tenant_id = $1::uuid`,
    [tenantId],
  );

  const comprobaciones = [
    {
      // Sin esto, una tabla vacía —por RLS mal puesta, por base equivocada—
      // aprobaría todo lo demás: «ningún pedido perdió su evento» es cierto de
      // forma trivial cuando no hay pedidos.
      nombre: 'Hay pedidos que verificar',
      ok: pedidos.n > 0,
      detalle:
        pedidos.n > 0
          ? `${pedidos.n} pedidos en la base`
          : 'CERO pedidos: la verificación no está mirando lo que cree',
    },
    {
      nombre: 'El outbox se drenó por completo',
      ok: drenaje.drenado,
      detalle: drenaje.drenado
        ? 'sin eventos pendientes'
        : `${drenaje.pendientes} eventos siguen pendientes tras ${ESPERA_DRENAJE_MS / 1000} s`,
    },
    {
      nombre: 'Cola de muertos vacía',
      ok: muertos.n === 0,
      detalle: `${muertos.n} eventos con los intentos agotados`,
    },
    {
      nombre: 'TODO pedido tiene su evento en el outbox',
      ok: sinEvento.n === 0,
      detalle:
        sinEvento.n === 0
          ? `${pedidos.n} pedidos, ${eventos.n} eventos de pedido`
          : `${sinEvento.n} pedidos SIN ningún evento — se perdieron por el camino`,
    },
  ];

  comprobaciones.push({
    nombre: 'TODO pedido aceptado llegó a la cocina',
    ok: sinTicket.n === 0,
    detalle:
      sinTicket.n === 0
        ? 'ningún pedido aceptado se quedó sin ticket'
        : `${sinTicket.n} pedidos aceptados SIN ticket de cocina`,
  });

  // Solo se juzga la ingesta si la hubo: `make load-peak` a secas no manda
  // webhooks, y una comprobación que falla por no haberse ejercitado enseña a
  // ignorarla.
  if (ingesta.hechos + ingesta.fallidos + ingesta.pendientes > 0) {
    comprobaciones.push({
      nombre: 'TODO webhook recibido acabó en un pedido',
      ok: ingesta.fallidos === 0 && ingesta.pendientes === 0,
      detalle: `${ingesta.hechos} procesados, ${ingesta.fallidos} fallidos, ${ingesta.pendientes} sin procesar`,
    });
  }

  if (creadosPorK6 !== null) {
    comprobaciones.push({
      nombre: 'Los pedidos en la base cuadran con los que k6 dio por creados',
      ok: pedidos.n >= creadosPorK6,
      detalle: `k6 creó ${creadosPorK6}, en la base hay ${pedidos.n}`,
    });
  }

  let fallos = 0;
  for (const c of comprobaciones) {
    console.log(`  [${c.ok ? '  OK  ' : ' FALLA'}] ${c.nombre}: ${c.detalle}`);
    if (!c.ok) fallos++;
  }

  console.log('');
  if (fallos > 0) {
    console.error(
      `${fallos} comprobación(es) de cero pérdida fallaron. NO se cumple el criterio de T4.30.`,
    );
    await pool.end();
    process.exit(1);
  }
  console.log(
    'Cero pérdida verificada: todo pedido aceptado dejó su evento.\n',
  );
  await pool.end();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
