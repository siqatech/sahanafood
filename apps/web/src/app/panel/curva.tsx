/**
 * La curva de ventas, en SVG y renderizada en el servidor.
 *
 * ### Por qué a mano y no con una librería
 *
 * CLAUDE.md prohíbe meter bibliotecas centrales sin ADR, y una de gráficos no
 * es poca cosa: las conocidas rondan los 100–500 KB y **todas** exigen que el
 * componente sea de cliente. El panel se abre desde el celular a las once de la
 * noche (specs/ux/03) y esta es la primera pantalla; pagar medio megabyte de
 * JavaScript por dos líneas es exactamente el intercambio que no queremos.
 *
 * Dos polilíneas en un `<svg>` no necesitan nada. Se pinta en el servidor, llega
 * dibujado y funciona sin JavaScript. Cuando haga falta un gráfico de verdad
 * —zoom, tooltips por punto, varias series seleccionables— eso sí es un ADR.
 *
 * ### Lo que el gráfico NO hace
 *
 * No inventa el eje. La escala arranca en cero **siempre**: un eje que empieza
 * en el mínimo convierte una variación del 3 % en un acantilado, y esta pantalla
 * la mira alguien que va a decidir si compra más pollo mañana.
 */

interface Punto {
  businessDate: string;
  netRevenue: string;
}

/** Céntimos desde la cadena decimal, sin pasar por coma flotante. */
function aCentimos(valor: string): number {
  const [entero = '0', decimales = ''] = valor.split('.');
  return Number(`${entero}${decimales.slice(0, 2).padEnd(2, '0')}`);
}

function ruta(valores: number[], alto: number, ancho: number, tope: number) {
  if (valores.length < 2) return '';
  const paso = ancho / (valores.length - 1);
  return valores
    .map((v, i) => {
      const x = i * paso;
      // El SVG crece hacia abajo: el valor se invierte para que más venta esté
      // más arriba, que es lo único que alguien espera de un gráfico.
      const y = alto - (tope === 0 ? 0 : (v / tope) * alto);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function diaCorto(fecha: string): string {
  const [, mes = '', dia = ''] = fecha.split('-');
  return `${dia}/${mes}`;
}

export function CurvaDeVentas({
  actual,
  anterior,
  etiqueta,
}: {
  actual: Punto[];
  anterior: Punto[];
  /** Qué se está comparando, para el pie. */
  etiqueta: string;
}) {
  const hoy = actual.map((p) => aCentimos(p.netRevenue));
  const antes = anterior.map((p) => aCentimos(p.netRevenue));

  // Sin una sola venta en 28 días no se dibuja una línea plana en cero: eso
  // parece un gráfico roto. Se dice lo que pasa.
  const tope = Math.max(...hoy, ...antes, 0);
  if (tope === 0) {
    return (
      <div className="grafico grafico--vacio">
        <p className="panel__vacio">
          Todavía no hay ventas en este periodo. En cuanto entre el primer
          pedido, aquí se verá la curva del día a día.
        </p>
      </div>
    );
  }

  const ANCHO = 720;
  const ALTO = 160;

  return (
    <div className="grafico">
      <svg
        viewBox={`0 0 ${ANCHO} ${ALTO + 18}`}
        className="grafico__lienzo"
        role="img"
        // El gráfico no puede ser la ÚNICA forma de leer el dato: quien usa un
        // lector de pantalla necesita la cifra, y debajo va la tabla con todos
        // los días. Aquí va el resumen.
        aria-label={`Ventas de los últimos ${actual.length} días comparadas con ${etiqueta}.`}
      >
        {/* Rejilla: tres líneas y nada más. Un fondo cuadriculado compite con
            los datos por la atención. */}
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1="0"
            x2={ANCHO}
            y1={ALTO * f}
            y2={ALTO * f}
            className="grafico__rejilla"
          />
        ))}

        {/* El periodo anterior va DETRÁS y punteado: es la referencia, no el
            protagonista. */}
        <path
          d={ruta(antes, ALTO, ANCHO, tope)}
          className="grafico__linea grafico__linea--anterior"
        />
        <path
          d={ruta(hoy, ALTO, ANCHO, tope)}
          className="grafico__linea grafico__linea--actual"
        />

        {/* Solo el primer y el último día. Catorce fechas apiladas en 720 px se
            solapan y no se lee ninguna. */}
        <text x="0" y={ALTO + 14} className="grafico__fecha">
          {diaCorto(actual[0]?.businessDate ?? '')}
        </text>
        <text
          x={ANCHO}
          y={ALTO + 14}
          textAnchor="end"
          className="grafico__fecha"
        >
          {diaCorto(actual[actual.length - 1]?.businessDate ?? '')}
        </text>
      </svg>

      <p className="grafico__leyenda">
        <span className="grafico__clave grafico__clave--actual" /> Este periodo
        <span className="grafico__clave grafico__clave--anterior" /> {etiqueta}
      </p>
    </div>
  );
}
