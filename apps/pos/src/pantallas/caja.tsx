import { useCallback, useEffect, useState } from 'react';
import { Money } from '@sahana/domain';
import {
  api,
  ApiError,
  SinRed,
  type ArqueoDeCaja,
  type SesionDeCaja,
} from '../lib/api';
import {
  DENOMINACIONES,
  diferencia,
  exigeAprobacion,
  lineasDelConteo,
  totalContado,
  type Conteo,
} from '../lib/arqueo';

/**
 * Caja: abrir turno, ver el arqueo en vivo y cerrar contando (ux/01).
 *
 * **Esta pantalla necesita red, y es a propósito.** Vender sin conexión sí;
 * arquear sin conexión, no: abrir y cerrar turno son actos de control —quién
 * responde del dinero— y hacerlos contra un estado local que quizá no cuadre
 * con el servidor produciría dos versiones del mismo turno.
 *
 * El aviso que hay que dar y se da: si quedan ventas sin sincronizar, el
 * esperado todavía no las incluye. Cerrar en ese momento produce un descuadre
 * que no es de nadie.
 */

function soles(m: Money): string {
  const [entero = '0', dec = ''] = m.toDecimalString().split('.');
  return `S/ ${entero}.${(dec + '00').slice(0, 2)}`;
}

export function Caja({
  token,
  locationId,
  sinSincronizar,
}: {
  token: string;
  locationId: string;
  sinSincronizar: number;
}) {
  const [sesion, setSesion] = useState<SesionDeCaja | null | undefined>(
    undefined,
  );
  const [arqueo, setArqueo] = useState<ArqueoDeCaja | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contando, setContando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const sesiones = await api.cajas(token, locationId);
      const abierta = sesiones.find((s) => s.status === 'open') ?? null;
      setSesion(abierta);
      setArqueo(abierta ? await api.arqueo(token, abierta.id) : null);
      setError(null);
    } catch (err) {
      setSesion(null);
      setError(
        err instanceof SinRed
          ? 'Sin conexión: la caja necesita internet. Las ventas siguen guardándose.'
          : 'No se pudo leer el estado de la caja.',
      );
    }
  }, [token, locationId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (sesion === undefined) return <p className="centrado">Cargando…</p>;

  if (!sesion) {
    return (
      <AbrirCaja
        token={token}
        locationId={locationId}
        error={error}
        alAbrir={() => {
          void cargar();
        }}
      />
    );
  }

  if (contando && arqueo) {
    return (
      <Conteo
        token={token}
        sesion={sesion}
        arqueo={arqueo}
        sinSincronizar={sinSincronizar}
        alCerrar={() => {
          setContando(false);
          void cargar();
        }}
        alCancelar={() => {
          setContando(false);
        }}
      />
    );
  }

  return (
    <div className="centrado tarjeta-grande">
      <h1>Caja abierta</h1>
      {error ? <p className="error">{error}</p> : null}
      {arqueo ? (
        <>
          <p className="apunte">
            Abierta desde {new Date(sesion.openedAt).toLocaleString('es-PE')} ·{' '}
            {arqueo.movements} movimiento(s)
          </p>
          <div className="ticket__total">
            <span>En gaveta (esperado)</span>
            <strong>
              {soles(Money.fromMinor(arqueo.expectedCash.minorUnits))}
            </strong>
          </div>
          <p className="apunte">
            Fondo inicial{' '}
            {soles(Money.fromMinor(arqueo.openingFloat.minorUnits))} · solo el
            efectivo mueve la gaveta; tarjeta y billetera se registran aparte.
          </p>
        </>
      ) : null}
      {sinSincronizar > 0 ? (
        <p className="error">
          Quedan {sinSincronizar} venta(s) sin enviar: el esperado todavía no
          las incluye. Espera a que se sincronicen antes de cerrar.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setContando(true);
        }}
      >
        Cerrar caja y contar
      </button>
    </div>
  );
}

function AbrirCaja({
  token,
  locationId,
  error,
  alAbrir,
}: {
  token: string;
  locationId: string;
  error: string | null;
  alAbrir: () => void;
}) {
  const [fondo, setFondo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [propio, setPropio] = useState<string | null>(null);

  async function abrir(): Promise<void> {
    setEnviando(true);
    setPropio(null);
    try {
      const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(fondo.trim() || '0');
      if (!m) {
        setPropio(`"${fondo}" no es un importe. Escríbelo como 100.00.`);
        return;
      }
      const minor = Number(`${m[1]}${(m[2] ?? '').padEnd(4, '0')}`);
      await api.abrirCaja(token, {
        locationId,
        openingFloatMinor: minor,
      });
      alAbrir();
    } catch (err) {
      if (err instanceof SinRed) setPropio('Sin conexión.');
      else if (err instanceof ApiError) setPropio(err.message);
      else setPropio('No se pudo abrir la caja.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="centrado tarjeta-grande">
      <h1>Abrir caja</h1>
      <p className="apunte">
        Cuenta el fondo con el que empieza el turno. Sin caja abierta, las
        ventas se cobran igual pero no hay arqueo que cuadrar al final.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {propio ? <p className="error">{propio}</p> : null}
      <label htmlFor="fondo">Fondo inicial</label>
      <input
        id="fondo"
        className="grande"
        inputMode="decimal"
        placeholder="100.00"
        value={fondo}
        onChange={(e) => {
          setFondo(e.target.value);
        }}
      />
      <button
        type="button"
        disabled={enviando}
        onClick={() => {
          void abrir();
        }}
      >
        {enviando ? 'Abriendo…' : 'Abrir caja'}
      </button>
    </div>
  );
}

/**
 * Conteo por denominación con diferencia en vivo.
 *
 * La diferencia se ve **mientras se cuenta**, no al final: es lo que hace que
 * quien cuenta vuelva a contar en el momento, y no que el descuadre aparezca
 * semanas después sin saber de qué día viene.
 */
function Conteo({
  token,
  sesion,
  arqueo,
  sinSincronizar,
  alCerrar,
  alCancelar,
}: {
  token: string;
  sesion: SesionDeCaja;
  arqueo: ArqueoDeCaja;
  sinSincronizar: number;
  alCerrar: () => void;
  alCancelar: () => void;
}) {
  const [conteo, setConteo] = useState<Conteo>({});
  const [motivo, setMotivo] = useState('');
  const [pin, setPin] = useState('');
  const [supervisor, setSupervisor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const contado = totalContado(conteo);
  const esperado = Money.fromMinor(arqueo.expectedCash.minorUnits);
  const dif = diferencia(contado, esperado);
  const hayQueFirmar = exigeAprobacion(dif);

  async function cerrar(): Promise<void> {
    setEnviando(true);
    setError(null);
    try {
      await api.cerrarCaja(token, sesion.id, {
        declaredCashMinor: contado.minorUnits,
        ...(motivo.trim() ? { differenceReason: motivo.trim() } : {}),
        ...(supervisor.trim() ? { supervisorId: supervisor.trim() } : {}),
        ...(pin.trim() ? { supervisorPin: pin.trim() } : {}),
      });
      alCerrar();
    } catch (err) {
      if (err instanceof SinRed) setError('Sin conexión: no se cerró la caja.');
      else if (err instanceof ApiError) setError(err.message);
      else setError('No se pudo cerrar la caja.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="conteo">
      <h1>Contar la gaveta</h1>
      {sinSincronizar > 0 ? (
        <p className="error">
          Quedan {sinSincronizar} venta(s) sin enviar. El esperado no las
          incluye: si cierras ahora, la diferencia no será de nadie.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="conteo__rejilla">
        {DENOMINACIONES.map((d) => (
          <div key={d.minor} className="conteo__fila">
            <span className="conteo__rotulo">{d.rotulo}</span>
            <input
              inputMode="numeric"
              aria-label={`Cuántos de ${d.rotulo}`}
              value={conteo[d.minor] ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                setConteo((previo) => ({
                  ...previo,
                  [d.minor]: Number.isFinite(n) ? n : 0,
                }));
              }}
            />
            <span className="dinero">
              {soles(
                Money.fromMinor(d.minor).multiplyByQuantity(
                  conteo[d.minor] ?? 0,
                ),
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="conteo__resumen">
        <div className="totales__fila">
          <span>Esperado</span>
          <span className="dinero">{soles(esperado)}</span>
        </div>
        <div className="totales__fila">
          <span>Contado</span>
          <span className="dinero">{soles(contado)}</span>
        </div>
        <div className="ticket__total">
          <span>Diferencia</span>
          <strong className={hayQueFirmar ? 'baja' : ''}>
            {dif.minorUnits > 0 ? '+' : ''}
            {soles(dif)}
          </strong>
        </div>
        {lineasDelConteo(conteo).length > 0 ? (
          <p className="apunte">
            {lineasDelConteo(conteo)
              .map((l) => `${l.cuantos} × ${l.rotulo}`)
              .join(' · ')}
          </p>
        ) : null}
      </div>

      {hayQueFirmar ? (
        <div className="conteo__firma">
          {/* Un cierre descuadrado sin firmar es la forma más limpia de que el
              dinero desaparezca sin que quede nadie señalado (RN-POS-02). */}
          <p className="apunte">
            Hay diferencia: hace falta motivo y el PIN de un supervisor.
          </p>
          <label htmlFor="motivo">¿Qué pasó?</label>
          <input
            id="motivo"
            value={motivo}
            onChange={(e) => {
              setMotivo(e.target.value);
            }}
            placeholder="Vuelto mal dado en el pedido 42"
          />
          <label htmlFor="supervisor">Supervisor (id)</label>
          <input
            id="supervisor"
            value={supervisor}
            onChange={(e) => {
              setSupervisor(e.target.value);
            }}
          />
          <label htmlFor="pin-sup">PIN del supervisor</label>
          <input
            id="pin-sup"
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
            }}
          />
        </div>
      ) : null}

      <div className="pie-acciones">
        <button type="button" className="discreto" onClick={alCancelar}>
          Volver
        </button>
        <button
          type="button"
          disabled={enviando}
          onClick={() => {
            void cerrar();
          }}
        >
          {enviando ? 'Cerrando…' : 'Cerrar caja'}
        </button>
      </div>
    </div>
  );
}
