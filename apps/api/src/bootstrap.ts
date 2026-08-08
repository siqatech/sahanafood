import { VersioningType, type INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, raw, urlencoded } from 'express';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';

/**
 * Configuración de la aplicación, en UN SOLO lugar.
 *
 * `main.ts` y las pruebas e2e llaman aquí. Si cada uno montara la app a su
 * manera, las pruebas dejarían de verificar lo que realmente se despliega: un
 * prefijo, un filtro de errores o una exclusión de versionado distintos bastan
 * para que una suite en verde conviva con un 404 en producción.
 *
 * Rutas fuera del prefijo `/api` y del versionado, a propósito:
 *  · `/metrics` — lo raspa Prometheus, que espera la ruta raíz por convención y
 *    no entiende de versiones de nuestra API de negocio.
 */
export const ROUTES_WITHOUT_PREFIX = ['metrics'];

/**
 * Opciones de CREACIÓN de la app (no configurables después de montarla, por eso
 * no van en `configureApp`). `main.ts` y las pruebas e2e usan estas mismas.
 *
 * `bodyParser: false` desactiva el parseo automático de Nest para montarlo a
 * mano en `configureApp`; el motivo está explicado ahí.
 */
export const NEST_APP_OPTIONS = { bodyParser: false } as const;

/**
 * Prefijos de las rutas que reciben webhooks externos firmados.
 *
 * Toda ruta que verifique un HMAC tiene que estar en esta lista: la firma se
 * calcula sobre los BYTES EXACTOS que mandó el emisor, y `express.json()` los
 * pierde al parsear. Olvidar añadir una ruta aquí no da un error claro — da
 * «firma inválida» en el 100 % de los avisos, y manda a depurar el secreto
 * equivocado.
 */
export const WEBHOOK_PATH_PREFIXES = [
  '/api/v1/integrations/webhooks',
  // Pagos (ADR-0016). Confirma cobros: si su firma no se puede verificar, no
  // se confirma nada.
  '/api/v1/payments/callbacks',
] as const;

/** @deprecated Usa `WEBHOOK_PATH_PREFIXES`. Se conserva por compatibilidad. */
export const WEBHOOK_PATH_PREFIX = WEBHOOK_PATH_PREFIXES[0];

const esWebhook = (req: IncomingMessage): boolean =>
  WEBHOOK_PATH_PREFIXES.some((prefijo) => (req.url ?? '').startsWith(prefijo));

/** Conserva los bytes exactos del cuerpo para poder verificar firmas HMAC. */
function capturarCuerpoCrudo(
  req: IncomingMessage & { rawBody?: Buffer },
  _res: ServerResponse,
  buf: Buffer,
): void {
  req.rawBody = buf;
}

/**
 * Parseo de cuerpos, montado a mano por DOS motivos que el parser por defecto
 * no puede cubrir a la vez:
 *
 * 1. Los webhooks se firman sobre BYTES. Un JSON re-serializado reordena claves
 *    y cambia espacios, así que verificar la firma sobre el objeto parseado
 *    rechazaría envíos perfectamente legítimos. De ahí `rawBody`.
 *
 * 2. Un payload TRUNCADO debe llegar al controlador. Con el parser JSON por
 *    delante, un cuerpo mal formado muere en un 400 genérico antes de tocar
 *    nuestro código — y ese webhook, que el proveedor da por entregado, se
 *    pierde. Justo lo que RN-INT-02 prohíbe. Por eso las rutas de webhook usan
 *    `raw`, que acepta cualquier byte sin interpretarlo.
 *
 * `raw` va PRIMERO y marca `req._body`, lo que hace que `json` se salte esas
 * peticiones (comportamiento documentado de body-parser).
 */
function configureBodyParsing(app: INestApplication): void {
  app.use(raw({ type: esWebhook, limit: '1mb', verify: capturarCuerpoCrudo }));
  app.use(json({ limit: '1mb', verify: capturarCuerpoCrudo }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
}

export function configureApp(app: INestApplication): void {
  configureBodyParsing(app);
  app.setGlobalPrefix('api', { exclude: ROUTES_WITHOUT_PREFIX });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
}
