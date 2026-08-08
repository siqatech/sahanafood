# Pruebas de carga (T4.30)

Perfil y umbrales salen de `docs/06-non-functional-requirements.md`, no de una
estimación:

> Throughput de diseño: **2 000 pedidos/hora sostenidos, pico 10× por 15 min**

2 000 pedidos/hora = 0,556 /s. El pico es **5,56 pedidos/s durante 15 minutos**.

El gate de la fase es doble, y las dos mitades miden cosas distintas:

| Criterio | Quién lo comprueba |
|---|---|
| **p95 de submit < 500 ms** | k6 (`submit-orders.js`), como *threshold* |
| **Cero pérdida: outbox = pedidos, DLQ = 0** | `verify-zero-loss.mjs`, contra Postgres |

Separarlas es deliberado. **La prueba de carga mide; la verificación juzga.** Una
API puede devolver 201 a cinco mil pedidos y haber perdido cien por el camino —
una transacción abortada, un evento que nunca salió del outbox— y los
percentiles saldrían preciosos. k6 no habla con Postgres y no puede saberlo.

## Cómo se ejecuta

```bash
make up                    # Postgres + Redis
make migrate

# La API y el worker se ejecutan COMPILADOS, no con el runner de desarrollo:
# se mide lo que va a producción.
pnpm --filter @sahana/api build
pnpm --filter @sahana/api start   &
pnpm --filter @sahana/api worker  &

make load                  # siembra + pico de 15 min + verificación
```

`make load` encadena los tres pasos. Para iterar sin esperar un cuarto de hora:

```bash
make load-seed
PEAK_DURATION=2m make load-peak
make load-verify
```

k6 corre en contenedor (`grafana/k6`). Una prueba que exige instalar un binario
a mano se ejecuta una vez y nunca más.

## Decisiones que afectan a lo que se mide

**Tasa de llegada constante, no usuarios virtuales.** Con VUs, si la API se pone
lenta el generador manda *menos* carga —los usuarios esperan su turno— y la
prueba se ablanda justo cuando debería apretar. Con `constant-arrival-rate` la
carga entra pase lo que pase, que es lo que hace un almuerzo de viernes. Por eso
`dropped_iterations` es un umbral: si k6 abandona peticiones por falta de VUs,
no midió el pico, midió otra cosa.

**Hay un minuto de calentamiento antes del pico.** Sin él, el primer minuto
mediría el arranque en frío —pool vacío, planes de consulta sin cachear— y
contaminaría el p95 de toda la prueba.

**Cada pedido lleva su `Idempotency-Key`.** Bajo carga los reintentos existen, y
sin la clave un timeout del cliente que reintenta crearía pedidos duplicados que
después se contarían como «pérdida negativa».

**El escenario se siembra por el camino real de producción** (`provisionTenant`),
no con INSERTs a mano: un escenario montado por otra vía mide algo que no se
parece a lo que va a estar en producción.

**El escenario es idempotente y reutilizable.** Una prueba de carga se repite
muchas veces —cambiando un índice, subiendo el pool— y crear un tenant nuevo en
cada vuelta haría que dos ejecuciones no se pudieran comparar.

## Ingesta desde marketplace

`ingest-webhooks.js` cubre el otro camino de entrada, que falla distinto: el
pedido llega por webhook firmado, tiene que quedar guardado **antes** de
procesarse (RN-INT-02) y el ack debe salir en menos de 250 ms — el marketplace
reintenta o marca el canal como caído si tardamos. Ese ack rápido es lo que hace
peligroso el camino, y solo es seguro si lo recibido se persiste primero.

T4.15 ya probó la cero pérdida ahí matando el worker; esto la prueba con
volumen, que es la otra forma de perder cosas.

## Sobre los números medidos

Una corrida en un portátil o en un contenedor compartido —con Postgres, Redis,
la API, el worker y el propio k6 en la misma máquina— da un **suelo**, no la
respuesta. Sirve para detectar regresiones y para saber que el sistema no se
cae; no para prometer un SLO. La medición que vale para el gate es la que se
haga sobre la infraestructura de destino, y esa necesita el entorno de
`docs/17-devops-and-deployment.md` levantado.

Los resultados de cada corrida (`results/*.json`) **no se versionan**: son datos
de una máquina y un momento. Lo que se versiona es el guion, que es lo
reproducible.
