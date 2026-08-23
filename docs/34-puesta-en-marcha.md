# Puesta en marcha

> Cómo levantar Sahana Food en un servidor y dar de alta al primer cliente.
> Verificado de punta a punta: imágenes construidas, stack arrancado,
> migraciones aplicadas, cliente creado y sesión iniciada.

Esto describe el despliegue de **una máquina**, que es el que sirve para los
tres operadores piloto y para un cliente pequeño. El despliegue gestionado
—réplicas, copias automáticas, balanceador— es Terraform y depende de **DT-02**.

---

## 1. Lo que hace falta

- Un servidor con Docker y Compose v2. **2 vCPU y 4 GB** bastan para un
  restaurante con dos locales.
- Un dominio para el panel y otro (o un subdominio) por cada tienda de cliente.
- Un proxy con TLS delante (Caddy, nginx o el del proveedor). **No es opcional**:
  por la API viajan tokens de sesión, y los contenedores escuchan en
  `127.0.0.1` justo para que no se publiquen sin cifrado por descuido.

## 2. Secretos

```bash
cp .env.example .env
```

Rellenar **todo lo marcado como obligatorio**. Cada secreto, propio:

```bash
openssl rand -base64 48
```

El proceso **no arranca** si en producción quedan los valores de ejemplo. No es
celo: están en el repositorio, así que cualquiera que lo haya leído podría
firmar tokens válidos y descifrar las credenciales de conector de todos los
clientes. Hay una prueba que lo comprueba.

Las tres contraseñas de rol (`SAHANA_APP_PASSWORD`, `..._MIGRATOR_...`,
`..._SUPPORT_...`) las usa el init de la base **al crear el volumen**. Cambiarlas
después no basta: hay que hacer `ALTER ROLE`.

## 3. Levantar

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env up -d
```

El orden lo resuelve el compose y **las migraciones son un servicio**, no un
paso manual: `migrate` corre con el rol migrador, termina, y solo entonces
arrancan API y worker. Dejarlo a mano es cómo se despliega una versión contra un
esquema viejo un viernes por la noche.

Comprobar:

```bash
curl -s localhost:3000/api/v1/health/ready
```

```json
{ "status": "ready", "schemaApplied": "0030_…", "schemaRequired": "0030_…", "database": "ok" }
```

`ready` exige que la base responda **y** que el esquema alcance al que trae la
imagen. Un esquema *por delante* también está listo: es el estado normal tras
revertir (§10).

## 4. Dar de alta al primer cliente

No hay endpoint para esto, y es deliberado: sin autenticar sería una puerta
abierta, y autenticado no serviría porque en un despliegue nuevo todavía no
existe ningún usuario. Exigir acceso al servidor es el nivel de autorización que
corresponde a «dar de alta a un cliente que paga».

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env \
  run --rm api node dist/database/provision.js \
    --nombre "Pollería El Buen Sabor" \
    --email duena@polleria.pe \
    --nombre-dueno "Rosa Quispe" \
    --plan growth
# la contraseña por entorno, para que no quede en el historial del shell:
#   -e SAHANA_OWNER_PASSWORD='…'
```

Devuelve el `tenantId` en JSON.

Con esa cuenta ya se entra al **panel** (§6): ver cómo va el día, editar la
carta y sus precios, pausar un plato, dar de alta marcas y locales. Lo que el
panel todavía no cubre —zonas de reparto, horarios, cocinas y estaciones— va por
el archivo de la sección siguiente.

## 5. Configurar el negocio

La configuración inicial va por archivo. El panel edita la carta y da de alta
marcas y locales, pero la empresa —con su RUC—, las zonas de reparto y los
horarios se describen aquí. Y es lo que hace repetible dar de alta a diez
clientes en vez de a uno:

```bash
cp infra/ejemplos/negocio.ejemplo.json negocio.json   # editar
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env \
  run --rm -v "$PWD/negocio.json:/tmp/negocio.json:ro" api \
  node dist/database/setup-business.js --tenant <TENANT_ID> --file /tmp/negocio.json
```

El archivo describe empresa, marcas, dominio de tienda, locales, cocinas,
estaciones, zonas de reparto, horarios, la carta entera con sus precios por
canal y sus modificadores, y **los insumos y recetas**. **Los importes van como
cadena en soles** (`"12.50"`) y se convierten a unidades menores con aritmética
entera: el precio que paga un cliente no pasa por coma flotante en ningún punto.

**La sección `inventario` no es opcional en la práctica.** Sin ella el negocio
vende con toda normalidad y **no descuenta nada**: el consumo automático solo se
dispara si el plato tiene receta, así que el food cost se queda en cero y nadie
lo nota hasta que alguien lo mira tres meses después. El costo de un insumo va
**por unidad** —por gramo, no por kilo— y la merma en **puntos básicos enteros**
(5 % = 500). Declarar inventario crea además el **almacén** del local si no se
nombró: un local sin almacén revienta al aceptar el primer pedido con receta, en
el worker, con la venta ya cobrada.

Es **idempotente**: volver a aplicarlo con la carta cambiada actualiza precios y
añade productos nuevos sin duplicar nada. Así se corrige un precio mal escrito
sin tocar la base a mano.

El ejemplo del repositorio **se aplica en CI de punta a punta**
(`setup-business-e2e`): se monta el negocio, se resuelve la tienda por su host,
se pide un pedido, se comprueba que cobra el precio del archivo **y que al
aceptarlo el kardex descuenta lo que dice la receta** —1200 g de pollo más un
5 % de merma, con la subreceta de crema estallada en mayonesa y ketchup—. Un
ejemplo que nadie ha ejecutado se descubre roto con el cliente delante.

### La carta desde un Excel

Escribir 180 productos en JSON es una tarde por cliente. El importador los lee
de una hoja de cálculo y produce el mismo `negocio.json` de arriba:

```bash
node dist/database/import-csv.js \
  --negocio negocio.json --productos carta.csv \
  --insumos insumos.csv --recetas recetas.csv \
  --salida negocio-final.json
```

Hay hojas de ejemplo en `infra/ejemplos/carta.ejemplo.csv`, `insumos.ejemplo.csv`
y `recetas.ejemplo.csv`. **Reproducen exactamente el `negocio.ejemplo.json`**, y
una prueba lo comprueba: así el camino del CSV hereda la verificación de punta a
punta del JSON en vez de tener una propia y más floja.

Es una transformación de archivos, no un alta: **no toca la base**. Se hace así
para que se pueda revisar el resultado antes de aplicarlo —importar la carta de
otra persona y publicarla sin mirarla es cómo se vende un pollo con un cero de
menos— y para que no haya un segundo camino de escritura al catálogo donde los
precios puedan salir distintos.

Detalles que importan porque el archivo sale de un Excel peruano:

- **Excel en español exporta con `;` y coma decimal.** `45,90` son cuarenta y
  cinco con noventa, y se lee bien. El separador se deduce de la cabecera.
- **Una columna por canal**: `precio_base` es el que sirve a cualquier canal sin
  uno propio; `precio_web`, `precio_pos`, `precio_rappi`… mandan sobre él.
  Añadir un canal es añadir una columna.
- **Los errores dicen fila y columna.** Un SKU repetido es un error, no gana el
  último: en una hoja de 180 líneas eso hace desaparecer un producto sin que
  nadie lo note.
- **Los grupos de modificadores no se importan**, se referencian por nombre. Son
  estructura (mínimo, máximo, si repite) y no caben en una celda sin inventar
  una sintaxis. Van en el JSON; si la hoja nombra uno que no existe, falla antes
  de aplicar en vez de publicar el plato sin sus extras.
- **Las recetas van en formato largo**: una fila por ingrediente, con la merma
  en puntos básicos enteros (5 % = 500).

## 6. El panel

```
https://<dominio-del-panel>/panel
```

Se entra con la cuenta de §4. La sesión son dos cookies `httpOnly` puestas por
el servidor: el token nunca llega a JavaScript, y el tenant sale del token, no
de la URL.

**Ponle un dominio propio y decláralo en `SAHANA_PANEL_HOST`.** Sin esa
variable el panel se sirve en cualquier host, incluidos los de las tiendas de
tus clientes: `polleria.pe/panel` enseñaría la pantalla de acceso de la
plataforma dentro de una tienda ajena. No hay fuga de datos —el tenant sale del
token— pero un formulario de acceso donde nadie lo espera es donde se pescan
contraseñas. Con la variable puesta, en cualquier otro host el panel responde
404, como cualquier ruta que no existe.

**Pon el WhatsApp de soporte en `SAHANA_SUPPORT_WHATSAPP`** (formato
internacional; sirve `+51 987 654 321` o `51987654321`, se limpia solo). Es el
destino del botón de Ayuda del panel. Sin ella la pantalla sigue funcionando
—compone el mensaje y deja copiarlo— pero no abre WhatsApp, porque un botón que
lo abre sin destinatario hace creer al operador que su mensaje salió.

**Y `SAHANA_VERSION` con la versión que despliegas.** Aparece en el mensaje que
el cliente le manda a soporte, y sin ella soporte no sabe si el fallo que le
describen ya está corregido. Si no la pones se dice «sin identificar», que es
peor que un número pero mejor que uno falso; en Railway se usa
`RAILWAY_GIT_COMMIT_SHA` como respaldo.

Lo que hay hoy: portada «¿cómo vamos hoy?» (ventas, pedidos, ticket promedio y
pedidos en marcha, comparados con el mismo día de la semana pasada), carta
—precios por canal, pausar y reactivar, añadir platos— y negocio —marcas y
locales—. Lo que no: pedidos, inventario, caja, clientes, integraciones. Está
especificado en `specs/ux/03-panel.md` y se construye por partes.

## 7. El POS y el KDS

Son una PWA (`apps/pos`) que se sirve como archivos estáticos. Se instala en la
tablet desde el navegador —«Añadir a la pantalla de inicio»— y a partir de ahí
arranca **sin internet**.

Puesta en marcha de cada tablet:

1. En el panel, alguien con permiso de gestión emite un **código de
   emparejamiento** (`POST /api/v1/devices/pairing-codes`, con el local).
2. La tablet abre la PWA y escribe el código. Queda emparejada para siempre.
3. Cada cajero pone su **PIN** desde el panel, y a partir de ahí entra en dos
   toques: su nombre y cuatro dígitos.

El dispositivo dice **dónde** se vende y el PIN **quién** vende. Una tablet
robada se revoca de un clic y deja de servir aunque quien la tenga sepa el PIN.

**Cobrar no llama al servidor.** El total se calcula en el dispositivo con el
mismo `@sahana/domain` que usa el servidor al recalcular, la venta se encola en
el propio aparato y se sincroniza sola cuando vuelve la red. Con red o sin ella
el flujo es idéntico. Lo que sí necesita internet: emparejar, entrar la primera
vez, descargar la carta y el tablero de cocina.

Lo que todavía no trae: deshacer en el KDS (DT-11), cierre de caja por
denominación, impresión desde la tablet y modo TV del KDS. Está en
`apps/pos/README.md`.

## 8. Poner la tienda en un dominio

El tenant de cada tienda **sale del `Host`** y de nada más. Los pasos son:

1. Declarar el dominio en el archivo de §5 (`tienda.host`). El comando lo
   registra y lo marca verificado.
2. Apuntar el DNS del cliente al servidor.
3. En el proxy, enrutar ese dominio al puerto `3001` **conservando el `Host`
   original** (`proxy_set_header Host $host` en nginx; Caddy lo hace solo).

Si el proxy reescribe el `Host`, **todas las tiendas resolverán a la misma
marca**. Es el fallo más caro posible aquí y es silencioso: la página carga.

## 9. Copias de seguridad — responsabilidad de quien levanta

En este despliegue Postgres vive en el mismo servidor. **Nadie hace copias por
ti.** Lo mínimo antes de tener un cliente vendiendo:

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env \
  exec -T postgres pg_dump -U "$POSTGRES_SUPERUSER" "$POSTGRES_DB" \
  | gzip > "sahana-$(date +%F).sql.gz"
```

Diario, **fuera de la máquina**, y probando la restauración de vez en cuando:
una copia que nadie ha restaurado nunca no es una copia, es una carpeta.

## 10. Desplegar una versión nueva, y revertirla

Las imágenes se fijan por **tag**, nunca `latest`: revertir es volver a poner el
tag anterior, y con `latest` no hay tag anterior al que volver.

```bash
# Actualizar
SAHANA_API_IMAGE=…:2026-08-09-1 SAHANA_WEB_IMAGE=…:2026-08-09-1 \
  docker compose -f … --env-file .env up -d

# Revertir: el tag de antes. Y NADA MÁS.
SAHANA_API_IMAGE=…:2026-08-08-1 SAHANA_WEB_IMAGE=…:2026-08-08-1 \
  docker compose -f … --env-file .env up -d
```

**Después de actualizar, sincroniza los roles.**

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env \
  run --rm api node dist/database/sync-roles.js
```

Los roles del sistema se siembran **una sola vez, al dar de alta el cliente**.
Un permiso nuevo del catálogo llega así a los clientes futuros y a ninguno de
los actuales: el código empieza a exigirlo el día del despliegue y ningún rol lo
tiene. Lo que se ve entonces desde el local no se parece a un problema de
permisos —se parece a que la caja no cierra—, y por eso el paso va aquí y no en
un runbook de rescate. Es idempotente, solo añade, y correrlo cuando no hay nada
que sincronizar no cuesta nada.

**No se revierten migraciones.** El esquema se queda por delante, la sonda de
readiness lo da por listo, y eso funciona porque ninguna migración puede romper
a la versión anterior: lo impide el gate `pnpm migrations:check`, que corre en
CI y rechaza `DROP COLUMN`, renombrados, cambios de tipo y `NOT NULL` sin
`DEFAULT`. Las dos piezas son la misma garantía (docs/17, T5.35).

## 11. Qué mirar cuando algo va mal

| Síntoma | Dónde mirar |
|---|---|
| La API reinicia en bucle | `docker logs sahana-api-1`. Casi siempre es configuración: el proceso valida al arrancar y prefiere no arrancar |
| `/health/ready` dice `not_ready` con `database: ok` | El esquema va por detrás de la imagen: falta correr `migrate` |
| Una tienda enseña la carta de otra | El proxy está reescribiendo el `Host` (§8) |
| Los pedidos no llegan a cocina | El worker. `docker logs sahana-worker-1`: al arrancar imprime qué barridos y qué consumidores tiene activos |
| La cola crece | Métricas `outbox_pending` y `outbox_oldest_pending_seconds` (docs/18). Más de 1 000 pendientes es alerta |

## 12. Lo que este despliegue NO trae

Se dice aquí para que nadie lo descubra el día que haga falta:

- **Alta disponibilidad.** Un servidor. Si se cae, se cae todo.
- **Copias gestionadas.** Ver §9.
- **Escalado horizontal.** La API y el worker escalan con réplicas, pero el
  Postgres local no.
- **Canario.** El reparto de tráfico al 10 % necesita balanceador (**DT-02**).
  Lo que sí está: revertir sin tocar la base.
- **Certificados.** Los pone el proxy.
- **Un servidor para la PWA del POS.** `apps/pos` se compila a archivos
  estáticos y este compose **no los sirve**: hay que publicarlos en el proxy o
  en un alojamiento estático. Es un `pnpm --filter @sahana/pos build` y copiar
  `dist/`, pero nadie lo hace por ti.
