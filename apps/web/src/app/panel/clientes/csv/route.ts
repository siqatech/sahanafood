import { panel } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';

/**
 * Los clientes en CSV (docs/26: «exportar todo… sin pedir permiso a nadie»).
 *
 * El argumento es contra el lock-in: quien se quiera ir con su lista de
 * clientes tiene que poder hacerlo solo, sin abrir un ticket ni negociar con
 * nadie. Un export que hay que pedir no es un export, es un favor.
 *
 * Se apoya en el mismo endpoint que la pantalla, así que hereda su permiso
 * (`crm.read`) y su aislamiento por tenant: quien no puede ver la lista tampoco
 * puede bajársela. Ese es el motivo de no consultar la base por otro camino.
 *
 * **Los anonimizados salen igual**, con su teléfono ya borrado y marcados. Es
 * lo correcto: sus pedidos siguen contando para la contabilidad, y hacerlos
 * desaparecer del archivo dejaría un total de ventas que no cuadra con el de
 * Rentabilidad.
 */
export async function GET(peticion: Request): Promise<Response> {
  // Se respeta la búsqueda de la pantalla: quien filtró por «Ana» y le da a
  // exportar espera las de Ana, no las cuatro mil.
  const q = new URL(peticion.url).searchParams.get('q') ?? undefined;
  const clientes = await panel.clientes(q);

  const csv = aCsv(
    [
      'Telefono',
      'Nombre',
      'Pedidos',
      'Total gastado',
      'Ticket promedio',
      'Primer pedido',
      'Ultimo pedido',
      'Canales',
      'Anonimizado',
      'Sin publicidad',
    ],
    clientes.map((c) => [
      c.phone,
      c.name ?? '',
      String(c.orders),
      // Los importes salen como cadena decimal, tal cual llegan: convertirlos a
      // número aquí les metería coma flotante, y este archivo se usa para
      // cuadrar con la contabilidad.
      c.totalSpent,
      c.averageTicket,
      c.firstOrderAt,
      c.lastOrderAt,
      c.channels.join(' '),
      c.anonymized ? 'SI' : '',
      c.optedOut ? 'SI' : '',
    ]),
  );

  const hoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  return respuestaCsv(`clientes-${hoy}.csv`, csv);
}
