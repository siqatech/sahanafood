'use client';

import { useActionState } from 'react';
import {
  guardarBorrador,
  publicar,
  revertir,
  probar,
  guardarFuente,
  type EstadoAgente,
} from './acciones';
import type { ConfigDelAgente } from '../../../lib/panel-api';

/** Configurar, publicar y probar el agente (spec 19, ADR-0011). */

function Resultado({ estado }: { estado: EstadoAgente }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioAgente({ config }: { config: ConfigDelAgente }) {
  const [estado, accion, pendiente] = useActionState<EstadoAgente, FormData>(
    guardarBorrador,
    {},
  );
  // Lo tecleado gana sobre lo guardado: un error en un campo no puede borrar
  // los otros seis.
  const v = estado.valores;

  return (
    <form action={accion}>
      <input type="hidden" name="configId" value={config.id} />

      <div className="campo">
        <label htmlFor="ag-nombre">Cómo se llama</label>
        <input
          id="ag-nombre"
          name="name"
          defaultValue={v?.['name'] ?? config.identity.name ?? ''}
          placeholder="Sahi"
        />
        <span className="tarjeta__pie">
          Lo usa al saludar. Un bot sin nombre se lee como un formulario.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="ag-rol">Qué hace</label>
        <input
          id="ag-rol"
          name="role"
          defaultValue={v?.['role'] ?? config.identity.role ?? ''}
          placeholder="Toma pedidos y resuelve dudas de la carta"
        />
      </div>

      <div className="campo">
        <label htmlFor="ag-tono">Tono</label>
        <select
          id="ag-tono"
          name="tone"
          defaultValue={v?.['tone'] ?? config.identity.tone ?? 'amistoso'}
        >
          <option value="amistoso">Amistoso</option>
          <option value="formal">Formal</option>
          <option value="juvenil">Juvenil</option>
        </select>
      </div>

      <div className="campo">
        <label htmlFor="ag-largo">Longitud</label>
        <select
          id="ag-largo"
          name="length"
          defaultValue={v?.['length'] ?? config.identity.length ?? 'corta'}
        >
          <option value="corta">Corta</option>
          <option value="media">Media</option>
        </select>
        <span className="tarjeta__pie">
          En WhatsApp, corta. Un párrafo de cinco líneas se lee como spam.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="ag-emojis">
          <input
            id="ag-emojis"
            name="emojis"
            type="checkbox"
            defaultChecked={config.identity.emojis ?? false}
          />{' '}
          Usa emojis
        </label>
      </div>

      <div className="campo">
        <label htmlFor="ag-pautas">Pautas (una por línea)</label>
        <textarea
          id="ag-pautas"
          name="guidelines"
          rows={4}
          defaultValue={v?.['guidelines'] ?? config.guidelines.join('\n')}
          placeholder={
            'Ofrece siempre la promo del día\nNo prometas horas exactas'
          }
        />
      </div>

      <div className="campo">
        <label htmlFor="ag-prohibido">De qué NO habla (una por línea)</label>
        <textarea
          id="ag-prohibido"
          name="forbiddenTopics"
          rows={3}
          defaultValue={
            v?.['forbiddenTopics'] ??
            (config.limits.forbiddenTopics ?? []).join('\n')
          }
          placeholder={'Reclamos legales\nDatos de otros clientes'}
        />
        <span className="tarjeta__pie">
          Al tocar uno, deriva a una persona en vez de improvisar.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="ag-derivacion">Qué dice al pasar a una persona</label>
        <input
          id="ag-derivacion"
          name="handoffMessage"
          defaultValue={
            v?.['handoffMessage'] ?? config.limits.handoffMessage ?? ''
          }
          placeholder="Te paso con alguien del local, un momentito."
        />
        <span className="tarjeta__pie">
          Vacío, el cliente ve silencio y repite la pregunta hasta cansarse.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="ag-activo">
          <input
            id="ag-activo"
            name="enabled"
            type="checkbox"
            defaultChecked={config.enabled}
          />{' '}
          Agente activo
        </label>
        <span className="tarjeta__pie">
          Desactivado, todo lo que llegue va directo a la bandeja de personas.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar borrador'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonesDeVersion({
  configId,
  hayPublicada,
}: {
  configId: string;
  hayPublicada: boolean;
}) {
  const [estadoP, accionP, pendienteP] = useActionState<EstadoAgente, FormData>(
    publicar,
    {},
  );
  const [estadoR, accionR, pendienteR] = useActionState<EstadoAgente, FormData>(
    revertir,
    {},
  );
  return (
    <>
      <div className="en-linea">
        <form action={accionP}>
          <input type="hidden" name="configId" value={configId} />
          <button type="submit" disabled={pendienteP}>
            {pendienteP ? 'Publicando…' : 'Publicar'}
          </button>
        </form>
        {hayPublicada ? (
          <form action={accionR}>
            <input type="hidden" name="configId" value={configId} />
            <button type="submit" className="discreto" disabled={pendienteR}>
              {pendienteR ? '…' : 'Volver a la anterior'}
            </button>
          </form>
        ) : null}
      </div>
      <Resultado estado={estadoP} />
      <Resultado estado={estadoR} />
    </>
  );
}

export function Sandbox({ brandId }: { brandId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoAgente, FormData>(
    probar,
    {},
  );
  const t = estado.prueba;

  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="brandId" value={brandId} />
        <input
          name="text"
          defaultValue={estado.valores?.['text'] ?? ''}
          placeholder="¿Tienen pollo a la brasa?"
          aria-label="Mensaje de prueba"
        />
        <button type="submit" disabled={pendiente}>
          {pendiente ? 'Probando…' : 'Probar'}
        </button>
      </form>

      {t ? (
        <article className="ficha">
          <p>
            <strong>{t.text ?? '(no contesta con texto)'}</strong>
          </p>
          {/* La traza es lo que hace depurable un «me contestó raro»: dice si
              fue una regla, el modelo o una fuente, y qué dijo el validador. */}
          <p className="tarjeta__pie">
            Resolución: {t.resolution}
            {t.trace.ruleName ? ` · regla «${t.trace.ruleName}»` : ''}
            {t.trace.promptVersion
              ? ` · prompt ${t.trace.promptVersion}`
              : ' · sin modelo'}
            {t.trace.sourceIds.length > 0
              ? ` · ${t.trace.sourceIds.length} fuentes`
              : ''}
            {t.trace.toolsCalled.length > 0
              ? ` · herramientas: ${t.trace.toolsCalled.join(', ')}`
              : ''}
            {` · ${t.trace.credits} créditos`}
          </p>
          {t.trace.validator && !t.trace.validator.ok ? (
            <p className="panel__error">
              El validador la habría frenado: {t.trace.validator.reason}
            </p>
          ) : null}
        </article>
      ) : null}
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioFuente() {
  const [estado, accion, pendiente] = useActionState<EstadoAgente, FormData>(
    guardarFuente,
    {},
  );
  const v = estado.valores;
  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="fu-titulo">Título</label>
        <input
          id="fu-titulo"
          name="title"
          defaultValue={v?.['title'] ?? ''}
          placeholder="Política de reparto"
        />
      </div>
      <div className="campo">
        <label htmlFor="fu-tema">Tema</label>
        <input
          id="fu-tema"
          name="topic"
          className="corto"
          defaultValue={v?.['topic'] ?? ''}
          placeholder="reparto"
        />
      </div>
      <div className="campo">
        <label htmlFor="fu-texto">Texto</label>
        <textarea
          id="fu-texto"
          name="body"
          rows={5}
          defaultValue={v?.['body'] ?? ''}
        />
        <span className="tarjeta__pie">
          Nada de precios ni de stock aquí: eso lo consulta el agente en vivo
          (ADR-0011). Un precio escrito en una fuente queda congelado y el bot
          lo repetirá cuando ya no sea verdad.
        </span>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar fuente'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}
