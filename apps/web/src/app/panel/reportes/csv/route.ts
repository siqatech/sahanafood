import { totalizarRentabilidad } from '@sahana/domain';
import { panel } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';
import { solesDeTexto } from '../../caja/dinero';

/**
 * La rentabilidad del periodo, en CSV.
 *
 * Este es el archivo que acaba en el correo del contador, así que trae **el
 * mismo periodo que hay en pantalla** y **la misma fila de total**. Un export
 * que sumara distinto que la pantalla —o que no sumara— obliga a rehacer la
 * suma en Excel, y una suma hecha dos veces es una suma que va a discrepar.
 *
 * El total sale de `@sahana/domain`, igual que en la página: la misma función,
 * no una copia con un `reduce`.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const desde = url.searchParams.get('desde') ?? '';
  const hasta = url.searchParams.get('hasta') ?? '';
  if (desde === '' || hasta === '') {
    // 400 y no un archivo vacío: un CSV de cero filas parece un periodo sin
    // ventas, y quien lo abra concluirá que el negocio no vendió nada.
    return new Response('Indica el periodo con desde y hasta.', {
      status: 400,
    });
  }

  const filas = await panel.rentabilidad({ from: desde, to: hasta });
  const ordenadas = [...filas].sort((a, b) => a.marginBps - b.marginBps);
  const totales = totalizarRentabilidad(ordenadas);

  const porcentaje = (bps: number): string => {
    const entero = Math.trunc(bps / 100);
    const resto = Math.abs(bps % 100);
    return `${entero},${String(resto).padStart(2, '0')}`;
  };

  const csv = aCsv(
    [
      'Marca',
      'Canal',
      'Pedidos',
      'Cancelados',
      'Venta neta',
      'Descuentos',
      'Comision',
      'Food cost',
      'Margen',
      'Margen %',
      'Ticket promedio',
    ],
    [
      ...ordenadas.map((r) => [
        r.brandName,
        r.channel,
        r.orders,
        r.cancelled,
        solesDeTexto(r.netRevenue),
        solesDeTexto(r.discounts),
        solesDeTexto(r.commission),
        solesDeTexto(r.foodCost),
        solesDeTexto(r.contributionMargin),
        porcentaje(r.marginBps),
        solesDeTexto(r.averageTicket),
      ]),
      // La fila de total va DENTRO del archivo. Dejarla fuera obliga a sumar en
      // Excel una columna cuyo total ya estaba calculado bien aquí.
      [
        'TOTAL',
        '',
        totales.orders,
        totales.cancelled,
        solesDeTexto(totales.netRevenue),
        solesDeTexto(totales.discounts),
        solesDeTexto(totales.commission),
        solesDeTexto(totales.foodCost),
        solesDeTexto(totales.contributionMargin),
        porcentaje(totales.marginBps),
        solesDeTexto(totales.averageTicket),
      ],
    ],
  );

  return respuestaCsv(`rentabilidad-${desde}-a-${hasta}.csv`, csv);
}
