import { useMemo, useState } from 'react';
import { Money } from '@sahana/domain';
import type { CartaResuelta, ProductoDeCarta } from '../lib/api';
import {
  aPedidoOffline,
  faltaPorElegir,
  nuevaLinea,
  totalDeLinea,
  totalDeTicket,
  vuelto,
  type LineaDeTicket,
  type SeleccionDeModificador,
} from '../lib/venta';
import { encolarVenta } from '../lib/sincronizacion';

/**
 * Pantalla de venta (ux/01).
 *
 * Reparto de la spec: **60 % rejilla, 40 % ticket**, con el total gigante abajo
 * y COBRAR de ancho completo. Cero menús: no hay hamburguesa en el flujo de
 * venta, es un anti-requisito explícito.
 *
 * Lo que hace que esto sea un POS y no una tienda: **al cobrar no se llama al
 * servidor**. La venta se encola en el dispositivo y se sincroniza cuando haya
 * red. Con red o sin ella el flujo es idéntico — no hay un «modo offline» que
 * solo se ejercita cuando algo falla, porque esos caminos siempre están rotos.
 */

const MEDIOS = [
  { id: 'cash', rotulo: 'Efectivo' },
  { id: 'card', rotulo: 'Tarjeta' },
  { id: 'wallet', rotulo: 'Yape / Plin' },
] as const;

/** Billetes con los que paga la gente en Perú. Ahorra teclear el monto. */
const BILLETES = [10, 20, 50, 100, 200];

function soles(m: Money): string {
  const [entero = '0', dec = ''] = m.toDecimalString().split('.');
  return `S/ ${entero}.${(dec + '00').slice(0, 2)}`;
}

export function Venta({
  carta,
  brandId,
  locationId,
  alCobrar,
}: {
  carta: CartaResuelta;
  brandId: string;
  locationId: string;
  alCobrar: (mensaje: string) => void;
}) {
  const [categoria, setCategoria] = useState<string | null>(
    carta.categories[0]?.id ?? null,
  );
  const [lineas, setLineas] = useState<LineaDeTicket[]>([]);
  const [eligiendo, setEligiendo] = useState<ProductoDeCarta | null>(null);
  const [cobrando, setCobrando] = useState(false);

  const total = useMemo(() => totalDeTicket(lineas), [lineas]);

  const productos = carta.products.filter(
    (p) => categoria === null || p.categoryId === categoria,
  );

  function agregar(
    producto: ProductoDeCarta,
    opciones: SeleccionDeModificador[],
  ): void {
    setLineas((previas) => [...previas, nuevaLinea(producto, opciones)]);
    setEligiendo(null);
  }

  function tocarProducto(producto: ProductoDeCarta): void {
    // Sin modificadores: un solo toque. Con ellos, pantalla completa. La spec
    // pide «máximo 3 toques + cobro» y este es el toque que se ahorra.
    if (producto.modifierGroups.length === 0) {
      agregar(producto, []);
      return;
    }
    setEligiendo(producto);
  }

  async function cobrar(medio: string): Promise<void> {
    const pedido = aPedidoOffline(lineas, {
      brandId,
      locationId,
      paymentMethod: medio,
      ahora: new Date(),
    });
    await encolarVenta(pedido);
    setLineas([]);
    setCobrando(false);
    alCobrar(`Cobrado ${soles(total)}.`);
  }

  if (eligiendo) {
    return (
      <Modificadores
        producto={eligiendo}
        alConfirmar={(opciones) => {
          agregar(eligiendo, opciones);
        }}
        alCancelar={() => {
          setEligiendo(null);
        }}
      />
    );
  }

  if (cobrando) {
    return (
      <Cobro
        total={total}
        alCobrar={(medio) => {
          void cobrar(medio);
        }}
        alCancelar={() => {
          setCobrando(false);
        }}
      />
    );
  }

  return (
    <div className="venta">
      <section className="carta">
        <nav className="pestanas">
          {carta.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.id === categoria ? 'pestana activa' : 'pestana'}
              onClick={() => {
                setCategoria(c.id);
              }}
            >
              {c.name}
            </button>
          ))}
        </nav>
        <div className="rejilla">
          {productos.map((p) => (
            <button
              key={p.id}
              type="button"
              className="producto"
              onClick={() => {
                tocarProducto(p);
              }}
            >
              <span className="producto__nombre">{p.name}</span>
              <span className="producto__precio">
                {soles(Money.fromMinor(p.price.minorUnits))}
              </span>
            </button>
          ))}
          {productos.length === 0 ? (
            <p className="apunte">
              Nada en esta categoría. Si falta un plato, revisa que tenga precio
              en el canal «mostrador».
            </p>
          ) : null}
        </div>
      </section>

      <aside className="ticket">
        <div className="ticket__lineas">
          {lineas.length === 0 ? (
            <p className="apunte">Toca un producto para empezar.</p>
          ) : (
            lineas.map((l) => (
              <div key={l.key} className="ticket__linea">
                <div>
                  <strong>
                    {l.quantity} × {l.productName}
                  </strong>
                  {l.modifiers.length > 0 ? (
                    <div className="apunte">
                      {l.modifiers.map((m) => m.name).join(', ')}
                    </div>
                  ) : null}
                </div>
                <div className="dinero">{soles(totalDeLinea(l))}</div>
                <button
                  type="button"
                  className="quitar"
                  aria-label={`Quitar ${l.productName}`}
                  onClick={() => {
                    setLineas((previas) =>
                      previas.filter((x) => x.key !== l.key),
                    );
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        <div className="ticket__total">
          <span>Total</span>
          <strong>{soles(total)}</strong>
        </div>
        <button
          type="button"
          className="cobrar"
          disabled={lineas.length === 0}
          onClick={() => {
            setCobrando(true);
          }}
        >
          COBRAR
        </button>
      </aside>
    </div>
  );
}

/**
 * Modificadores a pantalla completa (ux/01).
 *
 * El botón de confirmar se deshabilita **con explicación**: un botón gris sin
 * decir por qué es lo que hace que el cajero llame al encargado en mitad de la
 * cola.
 */
function Modificadores({
  producto,
  alConfirmar,
  alCancelar,
}: {
  producto: ProductoDeCarta;
  alConfirmar: (opciones: SeleccionDeModificador[]) => void;
  alCancelar: () => void;
}) {
  const [elegidas, setElegidas] = useState<Set<string>>(new Set());

  const falta = faltaPorElegir(producto.modifierGroups, elegidas);

  const seleccion: SeleccionDeModificador[] = producto.modifierGroups
    .flatMap((g) => g.options)
    .filter((o) => elegidas.has(o.id))
    .map((o) => ({
      id: o.id,
      name: o.name,
      priceDeltaMinor: o.priceDeltaMinor,
    }));

  function alternar(
    id: string,
    grupo: (typeof producto.modifierGroups)[number],
  ) {
    setElegidas((previas) => {
      const copia = new Set(previas);
      if (copia.has(id)) {
        copia.delete(id);
        return copia;
      }
      // Grupo de uno: elegir sustituye, no acumula. Es lo que espera cualquiera
      // ante un «¿con qué guarnición?».
      if (grupo.maxSelections === 1) {
        for (const o of grupo.options) copia.delete(o.id);
      }
      copia.add(id);
      return copia;
    });
  }

  return (
    <div className="modificadores">
      <h1>{producto.name}</h1>
      {producto.modifierGroups.map((g) => {
        const cuantas = g.options.filter((o) => elegidas.has(o.id)).length;
        return (
          <fieldset key={g.id}>
            <legend>
              {g.name}{' '}
              <span className="apunte">
                {g.minSelections > 0 ? 'obligatorio · ' : ''}
                {cuantas}/{g.maxSelections}
              </span>
            </legend>
            <div className="rejilla">
              {g.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={
                    elegidas.has(o.id) ? 'producto elegido' : 'producto'
                  }
                  disabled={!o.available}
                  onClick={() => {
                    alternar(o.id, g);
                  }}
                >
                  <span className="producto__nombre">{o.name}</span>
                  {o.priceDeltaMinor !== 0 ? (
                    <span className="producto__precio">
                      {o.priceDeltaMinor > 0 ? '+' : '−'}{' '}
                      {soles(Money.fromMinor(Math.abs(o.priceDeltaMinor)))}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </fieldset>
        );
      })}
      <div className="pie-acciones">
        <button type="button" className="discreto" onClick={alCancelar}>
          Cancelar
        </button>
        <button
          type="button"
          disabled={falta !== null}
          onClick={() => {
            alConfirmar(seleccion);
          }}
        >
          {falta ?? 'Añadir al ticket'}
        </button>
      </div>
    </div>
  );
}

/** Cobro: medio de pago y, en efectivo, teclado de vuelto en vivo (ux/01). */
function Cobro({
  total,
  alCobrar,
  alCancelar,
}: {
  total: Money;
  alCobrar: (medio: string) => void;
  alCancelar: () => void;
}) {
  const [medio, setMedio] = useState<string | null>(null);
  const [entregado, setEntregado] = useState('');

  const recibido = entregado === '' ? null : Money.fromMinor(Number(entregado));
  const cambio = recibido ? vuelto(total, recibido) : null;

  if (medio !== 'cash') {
    return (
      <div className="centrado tarjeta-grande">
        <h1>{soles(total)}</h1>
        <p className="apunte">¿Cómo paga?</p>
        <div className="rejilla">
          {MEDIOS.map((m) => (
            <button
              key={m.id}
              type="button"
              className="producto"
              onClick={() => {
                if (m.id === 'cash') setMedio('cash');
                else alCobrar(m.id);
              }}
            >
              {m.rotulo}
            </button>
          ))}
        </div>
        <button type="button" className="discreto" onClick={alCancelar}>
          Volver al ticket
        </button>
      </div>
    );
  }

  return (
    <div className="centrado tarjeta-grande">
      <h1>{soles(total)}</h1>
      <p className="apunte">¿Con cuánto paga?</p>
      <div className="rejilla">
        {BILLETES.map((b) => (
          <button
            key={b}
            type="button"
            className="producto"
            onClick={() => {
              setEntregado(String(b * 10_000));
            }}
          >
            S/ {b}
          </button>
        ))}
        <button
          type="button"
          className="producto"
          onClick={() => {
            setEntregado(String(total.minorUnits));
          }}
        >
          Justo
        </button>
      </div>
      {recibido ? (
        <p className="vuelto">
          {cambio === null ? (
            <span className="error">
              Faltan {soles(total.subtract(recibido))}
            </span>
          ) : (
            <>
              Vuelto <strong>{soles(cambio)}</strong>
            </>
          )}
        </p>
      ) : null}
      <div className="pie-acciones">
        <button
          type="button"
          className="discreto"
          onClick={() => {
            setMedio(null);
            setEntregado('');
          }}
        >
          Otro medio
        </button>
        <button
          type="button"
          disabled={cambio === null}
          onClick={() => {
            alCobrar('cash');
          }}
        >
          Cobrar
        </button>
      </div>
    </div>
  );
}
