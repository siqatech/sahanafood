import type { Metadata } from 'next';
import {
  INCIDENTES,
  ordenados,
  abiertos,
  diasSinIncidentes,
  type Incidente,
} from './incidentes';

/**
 * Página pública de estado (docs/26: «la confianza se construye antes del
 * primer incidente»).
 *
 * Va fuera del grupo `(tienda)` y fuera de `/panel` por el mismo motivo que la
 * de desarrolladores: no es de ningún restaurante y quien la consulta puede no
 * tener cuenta —de hecho, si está mirando esto es probable que no pueda entrar—.
 *
 * ## La honestidad de esta página tiene un límite, y se dice
 *
 * Está servida por la misma infraestructura que el producto. Si se cae todo, se
 * cae también esta página, y entonces su silencio no significa «todo bien»: no
 * significa nada. Un aviso lo dice en voz alta en vez de dejar que alguien
 * deduzca tranquilidad de una página que no carga. Mover el estado a un
 * alojamiento independiente es lo correcto y está anotado como pendiente; hasta
 * entonces, decirlo es lo único honesto.
 */

export const metadata: Metadata = {
  title: 'Estado del servicio — Sahana Food',
  description: 'Si algo no va, aquí lo contamos. Incidentes y qué hicimos.',
};

/** Nada de esto se cachea: una página de estado con cinco minutos de retraso
 *  es una página que miente durante cinco minutos. */
export const dynamic = 'force-dynamic';

const API_URL = process.env['SAHANA_API_URL'] ?? 'http://localhost:3000';

type Sonda = 'ok' | 'degradado' | 'caido';

/**
 * Se le pregunta a la API si está lista.
 *
 * Con un tiempo máximo corto y a propósito: si la API tarda ocho segundos en
 * contestar, para quien está intentando cobrar **ya está caída**, y una página
 * de estado que se queda pensando junto con ella no informa de nada.
 */
async function sondear(): Promise<Sonda> {
  try {
    const r = await fetch(`${API_URL}/api/v1/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return 'degradado';
    const cuerpo = (await r.json()) as { status?: string };
    return cuerpo.status === 'ready' ? 'ok' : 'degradado';
  } catch {
    // No se distingue «no contesta» de «tarda demasiado»: para quien está
    // intentando trabajar son la misma cosa.
    return 'caido';
  }
}

const TITULAR: Record<Sonda, string> = {
  ok: 'Todo funciona',
  degradado: 'Funcionando con problemas',
  caido: 'No estamos pudiendo responder',
};

const EXPLICACION: Record<Sonda, string> = {
  ok: 'Los pedidos entran, la caja cobra y los comprobantes salen.',
  degradado:
    'El servicio responde, pero no del todo bien. Si algo te falla ahora mismo, escríbenos: es probable que ya lo sepamos.',
  caido:
    'No hemos podido comprobar el servicio. Si estás vendiendo, el POS sigue tomando pedidos sin conexión y los sube cuando vuelva.',
};

function Ficha({ incidente }: { incidente: Incidente }) {
  return (
    <article className="estado__incidente">
      <h3>{incidente.titulo}</h3>
      <p className="estado__meta">
        {incidente.fecha} · duró {incidente.duracion} ·{' '}
        <span className={`estado__marca estado__marca--${incidente.estado}`}>
          {incidente.estado}
        </span>
      </p>
      <p>
        <strong>Qué falló:</strong> {incidente.queFallo}
      </p>
      {incidente.queSiFuncionaba ? (
        <p>
          <strong>Qué sí funcionaba:</strong> {incidente.queSiFuncionaba}
        </p>
      ) : null}
      <p>
        <strong>Qué hicimos para que no se repita:</strong>{' '}
        {incidente.queSeHizo}
      </p>
    </article>
  );
}

export default async function EstadoPage() {
  const sonda = await sondear();
  const lista = ordenados(INCIDENTES);
  const sinResolver = abiertos(INCIDENTES);
  const dias = diasSinIncidentes(INCIDENTES, new Date());

  return (
    <main className="estado">
      <h1>Estado del servicio</h1>

      <section className={`estado__titular estado__titular--${sonda}`}>
        {/* El estado NUNCA va solo en color: aquí lo lee gente con prisa y a
            veces desde un móvil al sol. */}
        <h2>{TITULAR[sonda]}</h2>
        <p>{EXPLICACION[sonda]}</p>
      </section>

      <p className="estado__aviso">
        Esta página se sirve desde la misma infraestructura que el producto. Si
        se cayera todo, también se caería ella: que no cargue no quiere decir
        que todo esté bien, quiere decir que no se sabe.
      </p>

      <h2>Incidentes</h2>
      {sinResolver.length > 0 ? (
        <>
          <h3 className="estado__abiertos">Abiertos ahora</h3>
          {sinResolver.map((i) => (
            <Ficha key={`${i.fecha}-${i.titulo}`} incidente={i} />
          ))}
        </>
      ) : null}

      {lista.length === 0 ? (
        <p>
          No ha habido ninguno todavía. No es una promesa de que no vaya a
          haberlo: es que cuando lo haya, se contará aquí con lo que falló y qué
          hicimos, aunque quede feo.
        </p>
      ) : (
        <>
          {dias !== null ? (
            <p className="estado__meta">
              {dias} {dias === 1 ? 'día' : 'días'} desde el último incidente.
            </p>
          ) : null}
          {lista
            .filter((i) => i.estado === 'resuelto')
            .map((i) => (
              <Ficha key={`${i.fecha}-${i.titulo}`} incidente={i} />
            ))}
        </>
      )}
    </main>
  );
}
