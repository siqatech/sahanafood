import { createServer } from 'node:net';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig, type AgentConfig } from './config.js';

/**
 * Diagnóstico del agente.
 *
 * Existe porque «el servicio arrancó» no prueba nada: el agente arranca igual
 * con la impresora apagada, con el disco lleno y con el puerto ocupado por otro
 * programa. Los tres fallan más tarde, en hora punta, y con una comanda dentro.
 *
 * Esto lo comprueba ANTES, en la instalación, donde todavía hay alguien
 * delante con tiempo para arreglarlo.
 *
 * Cada comprobación dice qué HACER, no qué pasó. «EACCES» no le sirve a quien
 * monta un local; «no puedo escribir la cola, ejecuta el instalador con
 * permisos» sí.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const NODE_MINIMO = 22;

/** ¿Está libre el puerto? Ocupado = el agente no arrancará y nadie sabrá por qué. */
async function puertoLibre(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function comprobarNode(version = process.versions.node): CheckResult {
  const mayor = Number(version.split('.')[0]);
  return mayor >= NODE_MINIMO
    ? { name: 'Node.js', status: 'ok', detail: `v${version}` }
    : {
        name: 'Node.js',
        status: 'fail',
        detail: `v${version}: hace falta Node ${NODE_MINIMO} o superior. Instálalo antes de continuar.`,
      };
}

/**
 * ¿Se puede escribir la cola de verdad?
 *
 * No basta con mirar permisos: se escribe un fichero y se borra. Si esto falla
 * el agente arranca igual y pierde TODOS los trabajos al primer reinicio, que
 * es justo cuando más falta hacen.
 */
async function comprobarCola(queueFile: string): Promise<CheckResult> {
  const carpeta = dirname(queueFile);
  const sonda = join(carpeta, '.sahana-doctor');
  try {
    await mkdir(carpeta, { recursive: true });
    await writeFile(sonda, 'ok', 'utf8');
    await unlink(sonda);
    return { name: 'Cola en disco', status: 'ok', detail: queueFile };
  } catch (error) {
    return {
      name: 'Cola en disco',
      status: 'fail',
      detail: `No se puede escribir en ${carpeta} (${
        error instanceof Error ? error.message : String(error)
      }). Sin esto, un reinicio se lleva todos los trabajos pendientes.`,
    };
  }
}

async function comprobarPuerto(port: number): Promise<CheckResult> {
  return (await puertoLibre(port))
    ? { name: 'Puerto', status: 'ok', detail: `127.0.0.1:${port} libre` }
    : {
        name: 'Puerto',
        status: 'warn',
        detail: `127.0.0.1:${port} ocupado. Si el agente ya está corriendo es normal; si no, otro programa lo tiene y el agente no arrancará.`,
      };
}

/**
 * Impresora inalcanzable es `warn`, no `fail`: puede estar apagada mientras se
 * instala, y los trabajos esperarán en la cola sin perderse. Falla la
 * instalación por esto y quien la monta no puede terminar hasta que alguien
 * traiga el cable.
 */
async function comprobarImpresoras(
  config: AgentConfig,
): Promise<CheckResult[]> {
  return Promise.all(
    config.printers.map(async (p): Promise<CheckResult> => {
      const alcanzable = await p.transport.probe();
      return alcanzable
        ? { name: `Impresora "${p.name}"`, status: 'ok', detail: p.target }
        : {
            name: `Impresora "${p.name}"`,
            status: 'warn',
            detail: `${p.target} no responde. ¿Está encendida y en la misma red? Los trabajos esperarán en la cola.`,
          };
    }),
  );
}

/** Ejecuta el diagnóstico completo. No lanza: devuelve el parte. */
export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckResult[]> {
  const resultados: CheckResult[] = [comprobarNode()];

  let config: AgentConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    resultados.push({
      name: 'Configuración',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
    // Sin configuración válida el resto no se puede comprobar: seguir daría
    // una lista de errores derivados que esconden el único que importa.
    return resultados;
  }

  resultados.push({
    name: 'Configuración',
    status: 'ok',
    detail: `${config.printers.length} impresora(s), ancho ${config.ticketWidth}, puerto ${config.port}`,
  });
  resultados.push(await comprobarCola(config.queueFile));
  resultados.push(await comprobarPuerto(config.port));
  resultados.push(...(await comprobarImpresoras(config)));

  return resultados;
}

const SIMBOLO: Record<CheckStatus, string> = {
  ok: '  OK  ',
  warn: ' AVISO',
  fail: ' FALLA',
};

/** Formatea el parte para la consola del instalador. */
export function formatDoctor(resultados: CheckResult[]): string {
  const lineas = resultados.map(
    (r) => `[${SIMBOLO[r.status]}] ${r.name}: ${r.detail}`,
  );
  const fallos = resultados.filter((r) => r.status === 'fail').length;
  const avisos = resultados.filter((r) => r.status === 'warn').length;

  lineas.push('');
  lineas.push(
    fallos > 0
      ? `${fallos} problema(s) que impiden funcionar. Corrígelos y vuelve a ejecutar el diagnóstico.`
      : avisos > 0
        ? `Sin problemas bloqueantes, ${avisos} aviso(s). El agente puede arrancar.`
        : 'Todo correcto. El agente puede arrancar.',
  );
  return lineas.join('\n');
}

/** ¿Puede arrancar? Los avisos no bloquean; los fallos sí. */
export function doctorOk(resultados: CheckResult[]): boolean {
  return !resultados.some((r) => r.status === 'fail');
}
