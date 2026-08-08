import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
// En OTel 2.x `Resource` pasó a ser un TIPO y el recurso se construye con esta
// función; `new Resource({...})` era la forma de la 1.x y ya no compila.
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * OpenTelemetry (T3.14, docs/18).
 *
 * Objetivo del gate: seguir una petición de punta a punta,
 * **request → outbox → worker**. Ese salto es el que suele perderse: el worker
 * procesa el evento en otro proceso y minutos más tarde, así que sin propagar
 * el contexto explícitamente la traza se corta justo donde más falta hace
 * (¿por qué este pedido no llegó a la cocina?).
 *
 * Por eso el `trace_id` viaja DENTRO del evento del outbox (columna trace_id) y
 * el consumidor abre su span enlazándolo. No se depende de la propagación
 * automática, que no cruza una cola.
 *
 * Estándar abierto y sin dependencia de proveedor: se exporta por OTLP, que
 * consumen Grafana Tempo, Jaeger o cualquier colector.
 */

let sdk: NodeSDK | undefined;

export function startTracing(options: {
  serviceName?: string;
  serviceVersion?: string;
  endpoint?: string | undefined;
}): void {
  // Sin endpoint configurado no se arranca: en desarrollo y en pruebas no hay
  // colector, y un exportador que reintenta contra la nada llena los logs.
  if (!options.endpoint) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? 'sahana-api',
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${options.endpoint}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // El sistema de ficheros genera muchísimo ruido sin valor diagnóstico.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

/**
 * El tracer se resuelve EN CADA LLAMADA, no al importar el módulo.
 *
 * Capturarlo a nivel de módulo lo ata al proveedor que hubiera registrado en
 * ese instante — normalmente ninguno, porque los imports se evalúan antes de
 * `startTracing()`. El resultado sería un tracer inerte que no emite nada, con
 * la observabilidad silenciosamente apagada y sin ningún error visible.
 */
function getTracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer('sahana');
}

/**
 * Ejecuta `work` dentro de un span. Marca el span como error si lanza, para que
 * la traza refleje el fallo aunque la excepción se maneje aguas arriba.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await work(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * `trace_id` del span activo, para escribirlo en el outbox y en los logs.
 * Devuelve `undefined` si no hay traza activa (p. ej. sin colector configurado),
 * y en ese caso el `trace_id` del middleware HTTP sigue sirviendo de
 * correlación.
 */
export function currentTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  const traceId = span?.spanContext().traceId;
  // Un traceId de ceros significa "sin muestrear": no aporta correlación.
  return traceId && !/^0+$/.test(traceId) ? traceId : undefined;
}
