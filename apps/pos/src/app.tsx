import { useCallback, useEffect, useState } from 'react';
import { api, SinRed, type CartaResuelta } from './lib/api';
import {
  almacen,
  type EstadoDeSesion,
  type EstadoDelDispositivo,
} from './lib/db';
import { tokenVigente } from './lib/sesion';
import { pendientes, sincronizarUnaVez } from './lib/sincronizacion';
import { Emparejar } from './pantallas/emparejar';
import { Entrar } from './pantallas/entrar';
import { Venta } from './pantallas/venta';
import { Cocina } from './pantallas/cocina';
import { Caja } from './pantallas/caja';
import { Impresoras } from './pantallas/impresoras';

/**
 * El armazón del POS/KDS.
 *
 * Un solo paquete para las dos superficies —es lo que dice CLAUDE.md— pero con
 * pantallas y temas separados: el POS se usa a treinta centímetros bajo presión
 * y el KDS a dos metros entre vapor (docs/25). Comparten dispositivo, sesión y
 * cola; no comparten nada visual.
 *
 * El orden de arranque es el que un local necesita: **primero se comprueba si
 * hay ventas encoladas**, antes que la carta y antes que nada. Una tablet que
 * arranca con veinte ventas sin sincronizar tiene que decirlo en la primera
 * pantalla, no cuando alguien se acuerde de mirar.
 */

const SINCRONIZAR_CADA_MS = 15_000;

type Modo = 'venta' | 'cocina' | 'caja' | 'impresoras';

export function App() {
  const [dispositivo, setDispositivo] = useState<
    EstadoDelDispositivo | null | undefined
  >(undefined);
  const [sesion, setSesion] = useState<EstadoDeSesion | null | undefined>(
    undefined,
  );
  const [carta, setCarta] = useState<CartaResuelta | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState<string>('');
  const [modo, setModo] = useState<Modo>('venta');
  const [sinSincronizar, setSinSincronizar] = useState(0);
  const [enLinea, setEnLinea] = useState(navigator.onLine);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const releerEstado = useCallback(async () => {
    setDispositivo((await almacen.dispositivo()) ?? null);
    setSesion((await almacen.sesion()) ?? null);
    setSinSincronizar(await pendientes());
  }, []);

  useEffect(() => {
    void releerEstado();
  }, [releerEstado]);

  // Estado de conexión SIEMPRE visible (docs/25 §5). `navigator.onLine` miente
  // a veces —dice «sí» con un router sin salida— así que la señal de verdad es
  // el resultado de sincronizar; esto es solo la primera pista.
  useEffect(() => {
    const arriba = () => {
      setEnLinea(true);
    };
    const abajo = () => {
      setEnLinea(false);
    };
    window.addEventListener('online', arriba);
    window.addEventListener('offline', abajo);
    return () => {
      window.removeEventListener('online', arriba);
      window.removeEventListener('offline', abajo);
    };
  }, []);

  /** Descarga la carta y la guarda. Si no hay red, se usa la guardada. */
  const prepararCarta = useCallback(async () => {
    const guardadaId = await almacen.marca();
    const token = await tokenVigente();

    if (guardadaId) {
      const local = await almacen.carta(guardadaId);
      if (local) {
        setBrandId(guardadaId);
        setCarta(local);
      }
    }
    if (!token) return;

    try {
      const marcas = (await api.marcas(token)).brands;
      const id = guardadaId ?? marcas[0]?.id;
      if (!id) return;
      const fresca = await api.carta(token, id);
      await almacen.guardarMarca(id);
      await almacen.guardarCarta(id, fresca);
      setBrandId(id);
      setBrandName(marcas.find((m) => m.id === id)?.name ?? '');
      setCarta(fresca);
    } catch (error) {
      if (!(error instanceof SinRed)) throw error;
      // Sin red se vende con la carta que ya está en disco. Es el caso normal
      // de un local con internet flojo, no una excepción.
    }
  }, []);

  useEffect(() => {
    if (sesion) void prepararCarta();
  }, [sesion, prepararCarta]);

  // Sincronización periódica. Se llama de más a propósito: lo ya sincronizado
  // no se reenvía, y lo que se reenvíe por error choca contra el dedupe.
  useEffect(() => {
    if (!sesion) return;
    let vivo = true;
    const vuelta = async (): Promise<void> => {
      const token = await tokenVigente();
      if (!token || !vivo) return;
      const resumen = await sincronizarUnaVez(token);
      if (!vivo) return;
      setSinSincronizar(resumen.pendientes);
      if (resumen.enviados > 0 && resumen.aceptados + resumen.duplicados > 0) {
        setMensaje(
          `Sincronizados ${resumen.aceptados + resumen.duplicados} pedidos.`,
        );
      }
      if (resumen.sinRed) setEnLinea(false);
      else if (resumen.enviados > 0) setEnLinea(true);
    };
    void vuelta();
    const id = setInterval(() => {
      void vuelta();
    }, SINCRONIZAR_CADA_MS);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [sesion]);

  if (dispositivo === undefined || sesion === undefined) {
    return <p className="centrado">Abriendo…</p>;
  }

  if (dispositivo === null) {
    return (
      <Emparejar
        alEmparejar={() => {
          void releerEstado();
        }}
      />
    );
  }

  if (sesion === null) {
    return (
      <Entrar
        dispositivo={dispositivo}
        alEntrar={() => {
          void releerEstado();
        }}
      />
    );
  }

  const locationId = dispositivo.locationId;

  return (
    <div className={modo === 'cocina' ? 'app app--cocina' : 'app'}>
      <header className="barra">
        <div className="barra__modos">
          <button
            type="button"
            className={modo === 'venta' ? 'activo' : ''}
            onClick={() => {
              setModo('venta');
            }}
          >
            Venta
          </button>
          <button
            type="button"
            className={modo === 'cocina' ? 'activo' : ''}
            onClick={() => {
              setModo('cocina');
            }}
          >
            Cocina
          </button>
          <button
            type="button"
            className={modo === 'caja' ? 'activo' : ''}
            onClick={() => {
              setModo('caja');
            }}
          >
            Caja
          </button>
          <button
            type="button"
            className={modo === 'impresoras' ? 'activo' : ''}
            onClick={() => {
              setModo('impresoras');
            }}
          >
            Impresoras
          </button>
        </div>
        <span className="barra__quien">{sesion.userName}</span>
        {/*
          Banner de conexión persistente (ux/01). Color E ícono, nunca solo
          color: docs/25 §6 lo exige y en una cocina con luz dura el color se
          pierde.
        */}
        <span
          className={enLinea ? 'estado estado--linea' : 'estado estado--sin'}
        >
          {enLinea
            ? '● En línea'
            : '▲ Sin conexión — las ventas se guardan aquí'}
          {sinSincronizar > 0 ? ` · ${sinSincronizar} por enviar` : ''}
        </span>
        <button
          type="button"
          className="discreto"
          onClick={() => {
            void almacen.cerrarSesion().then(releerEstado);
          }}
        >
          Salir
        </button>
      </header>

      {mensaje ? (
        <div
          className="aviso"
          onAnimationEnd={() => {
            setMensaje(null);
          }}
        >
          {mensaje}
        </div>
      ) : null}

      {modo === 'impresoras' ? (
        <Impresoras />
      ) : modo === 'caja' ? (
        locationId ? (
          <Caja
            token={sesion.accessToken}
            locationId={locationId}
            sinSincronizar={sinSincronizar}
          />
        ) : (
          <p className="centrado apunte">
            Esta tablet no está asignada a ningún local: no hay caja que abrir.
          </p>
        )
      ) : modo === 'venta' ? (
        carta && brandId && locationId ? (
          <Venta
            carta={carta}
            brandId={brandId}
            brandName={brandName}
            deviceName={dispositivo.deviceName}
            locationId={locationId}
            alCobrar={(m) => {
              setMensaje(m);
              void pendientes().then(setSinSincronizar);
            }}
          />
        ) : (
          <p className="centrado apunte">
            {locationId
              ? 'Descargando la carta… Necesita internet la primera vez.'
              : 'Esta tablet no está asignada a ningún local. Vuelve a emparejarla indicando el local.'}
          </p>
        )
      ) : (
        <CocinaConCocina token={sesion.accessToken} />
      )}
    </div>
  );
}

/**
 * El KDS necesita saber QUÉ cocina mira, y eso no está en la sesión.
 *
 * Se resuelve por la estructura del negocio: la primera cocina del local de
 * esta tablet. Elegir entre varias es configuración del dispositivo y todavía
 * no existe; se dice aquí en vez de fingir que el problema no está.
 */
function CocinaConCocina({ token }: { token: string }) {
  const [kitchenId, setKitchenId] = useState<string | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let vivo = true;
    (async () => {
      const dispositivo = await almacen.dispositivo();
      try {
        const res = await fetch(
          `${(import.meta.env['VITE_SAHANA_API_URL'] as string | undefined) ?? 'http://localhost:3000'}/api/v1/organization`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const estructura = (await res.json()) as {
          kitchens: Array<{ id: string; locationId: string }>;
        };
        const suya = estructura.kitchens.find(
          (k) => k.locationId === dispositivo?.locationId,
        );
        if (vivo) setKitchenId(suya?.id ?? null);
      } catch {
        if (vivo) setKitchenId(null);
      }
    })().catch(() => {
      if (vivo) setKitchenId(null);
    });
    return () => {
      vivo = false;
    };
  }, [token]);

  if (kitchenId === undefined) return <p className="centrado">Cargando…</p>;
  if (kitchenId === null) {
    return (
      <p className="centrado apunte">
        No encuentro una cocina en el local de esta tablet. Créala en el panel,
        en Negocio.
      </p>
    );
  }
  return <Cocina token={token} kitchenId={kitchenId} />;
}
