import Link from 'next/link';
import {
  panel,
  type FuenteDelAgente,
  type PresupuestoDeIa,
  type VersionDelAgente,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioAgente,
  BotonesDeVersion,
  Sandbox,
  FormularioFuente,
} from './formularios';

/**
 * El agente de IA (spec 19, ADR-0011).
 *
 * Es el módulo con más superficie construida y **cero pantalla**: identidad,
 * reglas deterministas, versiones con publicación y vuelta atrás, fuentes de
 * conocimiento, sandbox y presupuesto. Todo probado, todo inalcanzable.
 *
 * Lo que eso significa es peor que en otros módulos. El agente **habla en
 * nombre del negocio por escrito, a clientes reales**. Sin pantalla, lo que
 * diga es lo que quedó sembrado el día del alta: si el tono no encaja, si
 * promete algo que no se cumple o si contesta sobre un tema que no debería,
 * no había forma de corregirlo — y sí la había de que siguiera hablando.
 */

const ROTULO_ESTADO: Record<string, string> = {
  draft: 'Borrador',
  published: 'Publicada',
  archived: 'Archivada',
};

const ROTULO_PRESUPUESTO: Record<string, string> = {
  ok: 'Con margen',
  warning: 'Cerca del límite',
  exhausted: 'Agotado',
  disabled: 'Sin IA contratada',
};

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

export default async function AgentePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const estructura = await cargar('/panel/agente', yaSeIntento, () =>
    panel.estructura(),
  );
  const marcaPedida =
    typeof params['marca'] === 'string' ? params['marca'] : undefined;
  const marca =
    estructura.brands.find((b) => b.id === marcaPedida) ?? estructura.brands[0];

  if (!marca) {
    return (
      <>
        <h1>Agente</h1>
        <p className="panel__vacio">
          Todavía no hay ninguna marca. El agente se configura por marca porque
          cada una habla distinto.
        </p>
      </>
    );
  }

  const config = await cargar('/panel/agente', yaSeIntento, () =>
    panel.configDelAgente(marca.id),
  );

  // Cada bloque se degrada solo: quien tiene `ai.read` y no `ai.manage` puede
  // seguir mirando cómo responde el agente aunque no pueda cambiarlo.
  const [versiones, fuentes, presupuesto] = await Promise.all([
    panel.versionesDelAgente(marca.id).catch((): VersionDelAgente[] => []),
    panel.fuentesDelAgente().catch((): FuenteDelAgente[] => []),
    panel.presupuestoDeIa().catch((): PresupuestoDeIa | null => null),
  ]);

  const publicada = versiones.find((v) => v.status === 'published');

  return (
    <>
      <h1>Agente</h1>
      <p className="panel__subtitulo">
        Lo que el negocio contesta por escrito cuando no hay nadie mirando. Se
        configura por marca: cada una habla distinto.
      </p>

      {estructura.brands.length > 1 ? (
        <p className="tarjeta__pie">
          {estructura.brands.map((b) => (
            <span key={b.id}>
              <Link href={`/panel/agente?marca=${b.id}`}>
                {b.id === marca.id ? <strong>{b.name}</strong> : b.name}
              </Link>
              {' · '}
            </span>
          ))}
        </p>
      ) : null}

      {presupuesto ? (
        <p
          className={
            presupuesto.state === 'ok' ? 'tarjeta__pie' : 'panel__error'
          }
        >
          Presupuesto de IA:{' '}
          {ROTULO_PRESUPUESTO[presupuesto.state] ?? presupuesto.state} (
          {Math.round(presupuesto.ratio * 100)} % consumido).{' '}
          {/* Que las reglas sigan funcionando sin presupuesto es la mitad del
              valor de ADR-0011, y hay que decirlo aquí: si no, «agotado» se
              lee como «el bot dejó de contestar», que no es lo que pasa. */}
          {presupuesto.allowLlm
            ? ''
            : 'El modelo está apagado; las reglas deterministas siguen contestando.'}
        </p>
      ) : null}

      <h2>
        Cómo habla{' '}
        <span className="etiqueta">
          v{config.version} · {ROTULO_ESTADO[config.status] ?? config.status}
        </span>
      </h2>
      <p className="tarjeta__pie">
        Guardar <strong>no es publicar</strong>. Lo que lee un cliente es la
        última versión publicada
        {publicada?.publishedAt
          ? ` (v${publicada.version}, desde ${momento(publicada.publishedAt)})`
          : ' — todavía no hay ninguna'}
        .
      </p>

      <FormularioAgente config={config} />

      <h3>Publicar</h3>
      <BotonesDeVersion
        configId={config.id}
        hayPublicada={publicada !== undefined}
      />

      <h2>Probar sin clientes de por medio</h2>
      <p className="tarjeta__pie">
        Escribe lo que preguntaría un cliente y mira qué contestaría, con la
        traza: qué regla disparó, qué fuentes usó y qué dijo el validador. La
        alternativa —editar en vivo y ver qué pasa— se prueba con clientes
        reales.
      </p>
      <Sandbox brandId={marca.id} />

      <h2>Reglas</h2>
      <p className="tarjeta__pie">
        Se comprueban ANTES que el modelo (ADR-0011): lo que puede contestarse
        con una regla no se le pregunta a una IA. Se crean por API todavía; aquí
        se ven y se sabe cuáles se están usando de verdad.
      </p>
      {config.rules.length === 0 ? (
        <p className="panel__vacio">
          Sin reglas: todo lo resuelve el modelo o se deriva a una persona.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Regla</th>
                <th>Prioridad</th>
                <th>Coincide</th>
                <th>Veces usada</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {config.rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.priority}</td>
                  <td>{r.matchMode === 'all' ? 'todas' : 'cualquiera'}</td>
                  {/* Una regla con cero usos en semanas no está protegiendo
                      nada: o no coincide nunca o llega tarde por prioridad. */}
                  <td>{r.hitCount}</td>
                  <td>
                    {r.enabled ? (
                      'Activa'
                    ) : (
                      <strong className="baja">Desactivada</strong>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Fuentes</h2>
      <p className="tarjeta__pie">
        De dónde saca el contexto para responder. Siempre filtradas por este
        negocio: una fuente nunca se cruza entre clientes.
      </p>
      {fuentes.length === 0 ? (
        <p className="panel__vacio">
          Sin fuentes. El agente responde solo con reglas y con lo que consulta
          en vivo.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Título</th>
                <th>Tema</th>
                <th>Versión</th>
                <th>Veces usada</th>
              </tr>
            </thead>
            <tbody>
              {fuentes.map((f) => (
                <tr key={f.id}>
                  <td>{f.title}</td>
                  <td>{f.topic ?? '—'}</td>
                  <td>v{f.version}</td>
                  <td>{f.useCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Añadir una fuente</h3>
      <FormularioFuente />

      <h2>Versiones</h2>
      {versiones.length === 0 ? (
        <p className="panel__vacio">Todavía no hay historial.</p>
      ) : (
        <ul>
          {versiones.map((v) => (
            <li key={v.id}>
              v{v.version} — {ROTULO_ESTADO[v.status] ?? v.status}
              {v.publishedAt ? ` · publicada ${momento(v.publishedAt)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
