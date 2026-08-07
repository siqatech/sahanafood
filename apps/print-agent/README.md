# @sahana/print-agent

Agente local de impresión ESC/POS (ADR-0008).

## Por qué existe

El plan original decía «la PWA imprime localmente». Es falso: un navegador no
habla ESC/POS con una impresora térmica USB o de red de forma fiable. Sin este
agente, el POS offline no existe — se pueden tomar pedidos sin internet, pero la
cocina no recibe la comanda y el cliente no recibe su precuenta.

El agente es un servicio Node que corre en una máquina del local. La PWA imprime
**siempre** a través de él, nunca directo.

## Qué NO hace

No calcula dinero. Los importes llegan ya formateados desde quien llama, porque
el cálculo vive en `@sahana/domain` (regla innegociable de CLAUDE.md) y
duplicarlo aquí sería la vía más rápida a una precuenta que no cuadra con la
boleta.

No conoce el tenant ni habla con la API de Sahana: recibe bytes que imprimir de
la PWA que tiene delante. Es deliberado — un componente instalado en máquinas
ajenas no debe llevar credenciales de nube.

**No tiene ninguna dependencia de ejecución.** Es lo que hace que instalarlo sea
copiar una carpeta. Con una sola dependencia deja de serlo: `node_modules` en un
monorepo pnpm son enlaces al almacén, así que haría falta un bundler, o bajar
paquetes de npm dentro del local, o distribuir un tarball aplanado — tres piezas
más que pueden fallar donde menos podemos ir a arreglarlas. La validación de
peticiones está escrita a mano por eso (`src/api/validation.ts`), y hay una
prueba que impide reintroducir un import externo sin darse cuenta.

## Configuración

Todo por variables de entorno: quien instala es la persona que monta el local,
no un desarrollador.

| Variable | Obligatoria | Por defecto | Qué es |
|---|---|---|---|
| `AGENT_TOKEN` | Sí (mín. 16 car.) | — | Token de emparejamiento. Sin él no arranca |
| `PRINTERS` | No | `cocina=file:./salida/cocina.bin` | Impresoras, separadas por coma |
| `AGENT_PORT` | No | `7443` | Puerto, **siempre en 127.0.0.1** |
| `QUEUE_FILE` | No | `~/.sahana/print-queue.json` | Dónde persiste la cola |
| `TICKET_WIDTH` | No | `48` | Caracteres por línea (32 en papel de 58 mm) |

Formato de `PRINTERS`: `nombre=tipo:destino`, separados por coma.

```
cocina=net:192.168.1.50:9100,caja=file:/dev/usb/lp0
```

- `net:host:puerto` — ESC/POS crudo sobre TCP (puerto 9100). Es lo habitual en
  térmicas con ethernet o wifi.
- `file:/ruta` — escribe al dispositivo. En Linux, una térmica por USB es
  `/dev/usb/lp0`. En desarrollo, un fichero cualquiera para ver el ticket sin
  gastar papel.

## API local

Escucha **solo en 127.0.0.1**. Un agente en `0.0.0.0` deja que cualquier
teléfono conectado al wifi del local imprima en la cocina, y el wifi de un
restaurante no es una red de confianza.

Todas las rutas salvo `/health` exigen la cabecera `x-agent-token`, comparada en
tiempo constante.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | Estado del agente y de cada impresora. Pública: la PWA la consulta antes de tener token |
| `POST` | `/print/kitchen` | Encola una comanda de cocina. `202` con el `jobId` |
| `POST` | `/print/precheck` | Encola una precuenta. `202` con el `jobId` |
| `GET` | `/jobs` | Estado de la cola (sin los bytes del ticket) |
| `POST` | `/jobs/:id/reprint` | Reimprime creando un trabajo **nuevo** |
| `POST` | `/printers/test` | Página de prueba. Es lo que cierra una instalación |
| `GET` | `/printers/discover` | Escanea la red buscando térmicas en el puerto 9100 |

El `jobId` lo pone quien llama y sirve de clave de idempotencia: pulsar
«imprimir» dos veces porque la primera pareció no responder no saca dos
comandas.

Las respuestas son `202`, no `200`: se acusa recibo del encolado, no de que el
papel haya salido. Esperar a la impresora dejaría a la PWA bloqueada con el
cliente delante.

## Cola y fallos

Una térmica falla de formas que no son «error de red»: se queda sin papel a
media comanda, alguien la apaga para enchufar otra cosa, la tapa queda mal
cerrada.

- Los trabajos se **persisten en disco antes de intentar imprimir**, con
  escritura atómica (temporal + `rename`). Un corte de luz —el motivo habitual
  de reinicio en un local— no se lleva la cola por delante.
- Los fallos reintentan con backoff exponencial hasta 10 veces.
- **Nada se descarta.** Un trabajo agotado queda en `failed` y sigue siendo
  reimprimible: el operador prefiere reimprimir de más que descubrir que faltó
  una comanda.
- Lo que quedó `printing` al morir el proceso vuelve a la cola al arrancar.

## Desarrollo

```bash
pnpm --filter @sahana/print-agent test        # 117 pruebas
pnpm --filter @sahana/print-agent typecheck
AGENT_TOKEN=token-de-desarrollo-largo pnpm --filter @sahana/print-agent dev
AGENT_TOKEN=token-de-desarrollo-largo pnpm --filter @sahana/print-agent doctor
```

Los tickets se prueban comparando la **secuencia exacta de bytes**: es la única
forma de saber que están bien formados sin la impresora delante. Un `init`
olvidado hace que el siguiente ticket herede la negrita del anterior, y cortar
sin avanzar papel se lleva las últimas líneas.

## Instalación

Ver [`install/README.md`](install/README.md). Resumen:

```bash
pnpm --filter @sahana/print-agent build
sudo apps/print-agent/install/install.sh --token <TOKEN> --printers "cocina=net:192.168.1.50:9100"
```

El instalador valida todo antes de tocar nada, diagnostica, arranca el servicio
y **termina imprimiendo una página de prueba**: «el servicio arrancó» no prueba
nada — arranca igual con la impresora apagada. Lo que cierra la instalación es
un papel en la mano.

## Pendiente

- **Auto-actualización firmada** (ADR-0008). Hoy actualizar es volver a
  ejecutar el instalador con el `dist/` nuevo, que ya es idempotente.
- **Ejecución del instalador sobre hardware real** (entregable humano según las
  notas de `specs/phases/phase-4-operacion.md`), y `install.ps1` en Windows.
- **USB nativo en Windows.** En Linux se cubre con `file:/dev/usb/lp0`; en
  Windows hace falta un binding nativo. Una impresora configurada con un
  transporte no disponible queda en `UnavailablePrinter`: el trabajo espera en
  la cola con un error claro en vez de impedir que el agente arranque.
- **Reporte de salud a la nube** (ADR-0008 §3). Hoy `/health` lo expone para que
  lo consulte la PWA; falta que el panel lo reciba cuando hay red.
