import { VersioningType, type INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, raw, urlencoded } from 'express';
import { StorefrontService } from './modules/storefront/index.js';
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

/**
 * CORS para las tiendas de terceros (ADR-0020).
 *
 * Un cliente puede montar su web en WordPress o en React y pedir contra nuestra
 * API. Sin esto, el navegador se lo bloquea antes de salir y la integración es
 * imposible desde el navegador — que es donde vive el código de una web.
 *
 * La lista de orígenes sale de los DOMINIOS REGISTRADOS Y VERIFICADOS de los
 * clientes (`sto_domains`), y se consulta en cada comprobación. Nunca `*`: un
 * comodín convertiría el catálogo y los precios de cada cliente en algo que
 * cualquier web puede montar en su página.
 *
 * Se permite también sin origen (`undefined`), que es lo que mandan las
 * llamadas de servidor a servidor y las herramientas de línea de comandos. No
 * es un agujero: CORS protege al NAVEGADOR de que una página lea respuestas de
 * otro sitio, y una petición sin origen no viene de una página.
 */
function configureCors(app: INestApplication): void {
  const storefront = app.get(StorefrontService, { strict: false });

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, permitido?: boolean) => void,
    ) => {
      if (!origin) return callback(null, true);
      storefront
        .allowedOrigins()
        .then((permitidos) => callback(null, permitidos.includes(origin)))
        // Un fallo al consultar no puede convertirse en «permitido a todos».
        .catch(() => callback(null, false));
    },
    // `x-sahana-key` es la clave publicable; `idempotency-key` la que evita que
    // un reintento del cliente duplique un pedido.
    allowedHeaders: ['content-type', 'x-sahana-key', 'idempotency-key'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Sin cookies: la tienda de un tercero se identifica con su clave y con el
    // token de su carrito, no con una sesión nuestra.
    credentials: false,
    maxAge: 600,
  });
}

export function configureApp(app: INestApplication): void {
  configureBodyParsing(app);
  configureCors(app);
  app.setGlobalPrefix('api', { exclude: ROUTES_WITHOUT_PREFIX });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
}
