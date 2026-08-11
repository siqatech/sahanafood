'use server';

import { revalidatePath } from 'next/cache';
import {
  panel,
  PanelApiError,
  SesionCaducada,
  type RespuestaDePrueba,
} from '../../../lib/panel-api';

export interface EstadoAgente {
  error?: string;
  ok?: string;
  /** Lo tecleado, para no perderlo cuando el guardado falla. */
  valores?: Record<string, string>;
  /** Lo que contestaría el agente, con su traza. */
  prueba?: RespuestaDePrueba;
}

function traducir(
  error: unknown,
  valores?: Record<string, string>,
): EstadoAgente {
  const base = valores ? { valores } : {};
  if (error instanceof SesionCaducada) {
    return { ...base, error: 'Tu sesión caducó. Recarga y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { ...base, error: error.message };
  return { ...base, error: 'No se pudo. Inténtalo de nuevo.' };
}

/**
 * Guarda el BORRADOR del agente.
 *
 * Guardar no es publicar, y esa separación es el punto entero de la pantalla:
 * lo que el agente le dice a un cliente por escrito no puede cambiar porque
 * alguien tocó un campo y se fue a comer.
 */
export async function guardarBorrador(
  _prev: EstadoAgente,
  form: FormData,
): Promise<EstadoAgente> {
  const id = String(form.get('configId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const role = String(form.get('role') ?? '').trim();
  const tone = String(form.get('tone') ?? 'amistoso');
  const length = String(form.get('length') ?? 'corta');
  const emojis = form.get('emojis') === 'on';
  const guidelines = String(form.get('guidelines') ?? '');
  const forbidden = String(form.get('forbiddenTopics') ?? '');
  const handoff = String(form.get('handoffMessage') ?? '').trim();
  const enabled = form.get('enabled') === 'on';

  const valores = {
    name,
    role,
    tone,
    length,
    guidelines,
    forbiddenTopics: forbidden,
    handoffMessage: handoff,
  };

  if (name.length < 2) {
    return {
      error: 'El agente necesita un nombre: lo usa al saludar.',
      valores,
    };
  }
  if (handoff.length < 5) {
    // Es lo que lee el cliente cuando el bot se rinde. Vacío, el cliente ve un
    // silencio y repite la pregunta hasta que se cansa.
    return {
      error: 'Escribe qué se le dice al cliente cuando pasa a una persona.',
      valores,
    };
  }

  const lineas = (v: string): string[] =>
    v
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');

  try {
    await panel.guardarConfigDelAgente(id, {
      identity: { name, role, tone, length, emojis },
      guidelines: lineas(guidelines),
      limits: {
        forbiddenTopics: lineas(forbidden),
        handoffMessage: handoff,
      },
      enabled,
    });
  } catch (error) {
    return traducir(error, valores);
  }
  revalidatePath('/panel/agente');
  return {
    ok: 'Borrador guardado. Todavía NO es lo que contesta: hay que publicarlo.',
  };
}

/**
 * Publica el borrador.
 *
 * A partir de aquí es lo que el negocio dice por escrito a sus clientes, así
 * que se hace con un botón propio y a sabiendas.
 */
export async function publicar(
  _prev: EstadoAgente,
  form: FormData,
): Promise<EstadoAgente> {
  const id = String(form.get('configId') ?? '');
  try {
    const c = await panel.publicarAgente(id);
    revalidatePath('/panel/agente');
    return { ok: `Publicada la versión ${c.version}. Ya es lo que contesta.` };
  } catch (error) {
    return traducir(error);
  }
}

/** Vuelve a la versión anterior. Es el botón de «lo hemos liado». */
export async function revertir(
  _prev: EstadoAgente,
  form: FormData,
): Promise<EstadoAgente> {
  const id = String(form.get('configId') ?? '');
  try {
    const c = await panel.revertirAgente(id);
    revalidatePath('/panel/agente');
    return { ok: `Vuelta a la versión ${c.version}.` };
  } catch (error) {
    return traducir(error);
  }
}

/**
 * Prueba el agente sin que un cliente sea el conejillo de indias.
 *
 * Devuelve la respuesta **y la traza**: qué regla disparó, qué fuentes se
 * usaron, qué dijo el validador y cuánto costó. Sin la traza, «me contestó
 * raro» no se puede depurar; con ella se ve si fue una regla, el modelo o una
 * fuente desactualizada.
 */
export async function probar(
  _prev: EstadoAgente,
  form: FormData,
): Promise<EstadoAgente> {
  const brandId = String(form.get('brandId') ?? '');
  const text = String(form.get('text') ?? '').trim();
  if (text.length < 2)
    return { error: 'Escribe qué le preguntaría el cliente.' };

  try {
    const prueba = await panel.probarAgente({
      // Conversación inventada: el sandbox no manda nada a nadie, y usar una
      // real dejaría rastro en el hilo de un cliente.
      conversationId: '00000000-0000-4000-8000-000000000000',
      brandId,
      text,
    });
    return { prueba, valores: { text } };
  } catch (error) {
    return traducir(error, { text });
  }
}

/** Añade una fuente de conocimiento (RAG, siempre filtrado por tenant). */
export async function guardarFuente(
  _prev: EstadoAgente,
  form: FormData,
): Promise<EstadoAgente> {
  const title = String(form.get('title') ?? '').trim();
  const topic = String(form.get('topic') ?? '').trim();
  const body = String(form.get('body') ?? '').trim();
  const valores = { title, topic, body };

  if (title.length < 2)
    return { error: 'La fuente necesita un título.', valores };
  if (body.length < 10) {
    return {
      error: 'El texto es demasiado corto para servir de fuente.',
      valores,
    };
  }

  try {
    const r = await panel.guardarFuente({
      title,
      body,
      ...(topic !== '' ? { topic } : {}),
    });
    revalidatePath('/panel/agente');
    return { ok: `Guardada en ${r.chunks} fragmentos.` };
  } catch (error) {
    return traducir(error, valores);
  }
}
