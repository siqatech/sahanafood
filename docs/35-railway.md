# Despliegue en Railway

> Cómo poner Sahana Food en Railway: cuatro servicios, un Postgres y un Redis.
> Complementa `docs/34-puesta-en-marcha.md`, que describe el despliegue de una
> sola máquina con Docker Compose. Lo que cambia aquí es **quién administra la
> base de datos**; el resto —dar de alta clientes, configurar el negocio,
> emparejar tablets— es idéntico y no se repite.

Esto resuelve **DT-02**: el entorno gestionado deja de ser una decisión
pendiente. Railway construye desde los `Dockerfile` que ya existen, así que la
imagen que corre en producción es la misma que se prueba en CI y en local.

---

## 0. Lo primero, porque es lo que más caro sale

**Railway entrega una sola `DATABASE_URL`, y es la del rol administrador.**
Pegarla en la variable de la aplicación es el camino corto, evidente y el que
sugiere el propio panel del proveedor. También es el fallo más grave que este
sistema puede tener, y **no produce ningún error**:

Un rol superusuario —o con `BYPASSRLS`— hace que Postgres **ignore la Row Level
Security por completo**. Las consultas responden, las pruebas pasan, los pedidos
entran, y cada cliente ve los datos de todos los demás. No hay excepción, ni
log, ni síntoma. Se descubre el día que un cliente ve el nombre de otro.

Por eso hay dos defensas, y las dos hay que respetarlas:

1. `bootstrap:roles` (§3) crea los roles que el sistema espera y devuelve las
   URLs correctas.
2. La API y el worker **se niegan a arrancar** si detectan que se están
   conectando con un rol que puede saltarse RLS
   (`apps/api/src/database/preflight.ts`). Un despliegue mal configurado no
   llega a servir tráfico.

Si alguna vez ves este mensaje en los logs de Railway, no es un obstáculo que
haya que rodear — es la comprobación haciendo su trabajo:

```
La aplicación se está conectando como "postgres", que es superusuario.
Postgres IGNORA la Row Level Security con ese rol…
```

## 1. Los servicios

Un proyecto de Railway con seis piezas:

| Servicio    | Qué es                | Configuración                | Dominio público |
| ----------- | --------------------- | ---------------------------- | --------------- |
| `postgres`  | plugin de Railway     | **con pgvector** (§2)        | no              |
| `redis`     | plugin de Railway     | por defecto                  | no              |
| `api`       | `infra/railway/api.json`    | NestJS + migraciones   | sí (o solo privado) |
| `worker`    | `infra/railway/worker.json` | BullMQ, sin HTTP       | **no**          |
| `web`       | `infra/railway/web.json`    | Next.js: panel y tiendas | sí          |

Los tres archivos de `infra/railway/` son la configuración de cada servicio. En
Railway se declara uno por servicio, en *Settings → Config-as-code*, con la ruta
del archivo. Van versionados a propósito: la ruta del `Dockerfile`, el comando
de arranque y la sonda de salud son parte del código, no ajustes que alguien
recuerde haber tocado en una pantalla hace tres meses.

### Qué hace que un servicio se vuelva a desplegar

Cada archivo trae `build.watchPatterns`, y esa lista es más delicada de lo que
parece. Railway la usa para decidir si un `push` reconstruye el servicio o lo
salta con «No changes to watched files», y un patrón que se queda corto no da
error: **el despliegue se marca como saltado y producción se queda con el código
viejo**, en verde.

Es lo que pasó con la web, que vigilaba solo `/apps/web/**`. Con eso, un cambio
en `@sahana/domain` —donde vive el cálculo de totales— no la redesplegaba: la
API pasaba a calcular con la versión nueva y la tienda seguía sirviendo la
anterior. Por eso ahora los cinco vigilan además `/packages/**`, el `Dockerfile`,
el `.dockerignore` y el candado de dependencias: todo lo que puede cambiar la
imagen resultante sin tocar la carpeta de la aplicación.

Las listas viven en los archivos de `infra/railway/` y no en la pantalla de
Railway justamente porque este fallo es invisible: revisable en un diff, se ve;
en un formulario que alguien tocó una vez, no.

`api` y `worker` **comparten `Dockerfile`** y se diferencian solo en el comando.
No es ahorro de disco: es lo que garantiza que los dos calculen totales con
exactamente el mismo `@sahana/domain`. Con dos imágenes, un despliegue a medias
deja al worker calculando un importe con una versión y a la API con otra, y la
diferencia aparece en un comprobante ya emitido.

## 2. Postgres **tiene que traer pgvector**

El esquema declara una columna `vector(1536)` (`ai_kb_chunks`, migración 0028)
para la búsqueda por similitud del agente. No es opcional ni se puede
desactivar: sin la extensión, la migración 0028 se detiene y las siguientes no
llegan a aplicarse.

Al crear el Postgres, elige la plantilla que incluye **pgvector**. `bootstrap:roles`
lo comprueba en el primer comando del despliegue y falla ahí si falta, en vez de
a mitad de la cadena de migraciones con veintisiete tablas ya creadas.

Redis se usa para BullMQ (colas) y no guarda nada que no se pueda reconstruir
desde `outbox`: perderlo cuesta un reintento, no datos.

## 3. Preparar la base de datos (una sola vez)

Con la CLI de Railway, desde la raíz del repositorio:

```bash
railway link                      # elegir el proyecto
railway variables --service postgres    # copiar DATABASE_URL (la de admin)

# Dos contraseñas, distintas, propias:
export SAHANA_APP_PASSWORD="$(openssl rand -base64 24)"
export SAHANA_MIGRATOR_PASSWORD="$(openssl rand -base64 24)"

ADMIN_DATABASE_URL='postgres://postgres:…@…:5432/railway' \
  pnpm --filter @sahana/api bootstrap:roles
```

Devuelve, por stdout y en JSON, las dos URLs que hay que configurar:

```json
{
  "databaseUrl": "postgres://sahana_app:…@…/railway",
  "migrationDatabaseUrl": "postgres://sahana_migrator:…@…/railway"
}
```

Qué hace, y por qué cada cosa:

- **Instala pgvector.** `CREATE EXTENSION` exige superusuario y el rol migrador
  no lo es a propósito —es lo que impide que una migración se salte RLS—, así
  que se instala aquí, con el rol administrador.
- **Crea `sahana_migrator`**, dueño del esquema, que crea y altera tablas.
- **Crea `sahana_app`**, con `NOSUPERUSER NOCREATEROLE NOBYPASSRLS` explícitos y
  solo DML. Es el que usa la aplicación y el que RLS sí filtra.
- **Vuelve a revocar `UPDATE`/`DELETE` sobre las tablas append-only.** Concede
  DML sobre todas las tablas para cubrir el caso «la base ya estaba migrada», y
  ese permiso masivo desharía lo que cada migración revocó. Sin este paso,
  re-ejecutar el arranque dejaría el histórico de auditoría editable, en
  silencio. La lista vive en `apps/api/src/database/append-only.ts` y una prueba
  la compara con los `REVOKE` reales de las migraciones.

Es **idempotente**: repetirlo actualiza las contraseñas y vuelve a aplicar los
privilegios, que es justo lo que hace falta al rotar un secreto. En un
despliegue normal **no hace falta repetirlo**: las tablas nuevas heredan los
permisos por `ALTER DEFAULT PRIVILEGES`.

### Si el Postgres no es alcanzable desde fuera

Lo de arriba supone que puedes conectarte a la base desde tu máquina, lo que en
Railway exige activarle un **TCP Proxy** al servicio de Postgres (Settings →
Networking). Es un clic, y deja además `psql` a mano para operar.

Si prefieres **no exponer la base a internet** —que es la postura por defecto
razonable—, el arranque se ejecuta desde dentro de la red privada con un
servicio desechable:

1. Crear un servicio con `infra/railway/bootstrap.json` como configuración. Usa
   la misma imagen que la API y arranca `bootstrap-roles.js`; su política de
   reinicio es `NEVER` porque **termina y ya está**: sin eso, un proceso que
   sale con éxito se reinicia en bucle.
2. Darle tres variables: `ADMIN_DATABASE_URL` (apuntando a
   `postgres.railway.internal`), `SAHANA_APP_PASSWORD` y
   `SAHANA_MIGRATOR_PASSWORD`.
3. Comprobar en sus logs que terminó bien y **borrar el servicio**. Al borrarlo
   se van sus variables, así que la URL de administrador no queda guardada en
   ningún sitio.

No hace falta leer su salida para saber las dos URLs: son la de administrador
con el usuario y la contraseña cambiados, y esas contraseñas las eliges tú.

**La URL de administrador no va en ninguna variable de ningún servicio.**

## 4. Variables

En `api` y `worker`:

| Variable                  | Valor                                                        |
| ------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`            | `databaseUrl` del paso 3 (rol `sahana_app`)                  |
| `MIGRATION_DATABASE_URL`  | `migrationDatabaseUrl` del paso 3 (solo hace falta en `api`) |
| `REDIS_URL`               | `${{Redis.REDIS_URL}}`                                       |
| `JWT_ACCESS_SECRET`       | `openssl rand -base64 48`                                    |
| `JWT_REFRESH_SECRET`      | otro distinto                                                |
| `CREDENTIALS_MASTER_KEY`  | otro distinto                                                |
| `NODE_ENV`                | `production`                                                 |

Cada secreto, el suyo. El proceso **no arranca** si en producción quedan los
valores de ejemplo: están en el repositorio, así que cualquiera que lo haya
leído podría firmar tokens válidos y descifrar las credenciales de conector de
todos los clientes. Hay una prueba que lo comprueba.

En `web`:

| Variable            | Valor                                                        |
| ------------------- | ------------------------------------------------------------ |
| `SAHANA_API_URL`    | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3000`                |
| `SAHANA_PANEL_HOST` | el dominio del panel, p. ej. `panel.sahanafood.com`          |
| `NODE_ENV`          | `production`                                                 |

`SAHANA_API_URL` va por la **red privada** de Railway: la tienda habla con la
API sin salir a internet. Un salto de más en cada carga de catálogo se nota en
el móvil de quien está pidiendo.

`SAHANA_PANEL_HOST` **no es opcional en la práctica.** Sin él, `/panel` se sirve
también en los dominios de las tiendas de tus clientes: `polleria.pe/panel`
enseñaría la pantalla de acceso de la plataforma dentro de una tienda ajena. No
hay fuga de datos —el tenant sale del token— pero un formulario de acceso donde
nadie lo espera es donde se pescan contraseñas. Con la variable puesta, en
cualquier otro host el panel responde 404.

Si `api` no necesita ser pública —el caso normal: solo la consume `web`— no le
generes dominio. El POS y el print-agent sí la necesitan desde fuera; si los vas
a usar, dale dominio propio.

## 5. Migraciones

Las aplica el servicio `api` en su `preDeployCommand`, declarado en
`infra/railway/api.json`:

```
node dist/database/migrate.js && node dist/database/sync-roles.js
```

Railway lo ejecuta **antes** de poner la versión nueva en servicio y, si falla,
**no la pone**: la versión anterior sigue atendiendo. Es lo mismo que consigue el
servicio `migrate` del compose, y por el mismo motivo — dejarlo a mano es cómo
se despliega una versión contra un esquema viejo un viernes por la noche.

`sync-roles` va detrás porque los roles del sistema se siembran **por cliente**:
un permiso nuevo introducido en una versión no existe para los clientes ya
dados de alta hasta que se propaga. Es idempotente y solo añade.

Despliega `api` **antes** que `worker` la primera vez y cada vez que una versión
traiga migraciones: solo `api` migra, y un worker que arranque contra el esquema
viejo fallará hasta que la migración pase.

## 6. Sondas de salud

- `api` → `/api/v1/health/ready`. Exige que la base responda **y** que el
  esquema alcance al que trae la imagen. Un esquema *por delante* también está
  listo: es el estado normal tras revertir.
- `web` → `/api/salud`. Es una ruta propia, y no `/`, por una razón concreta: la
  tienda deduce la marca del `Host` del visitante, y la sonda de Railway llega
  con el host interno del proveedor. `/` sin una tienda para ese host responde
  **500**, así que sondear la raíz haría que el despliegue no entrara nunca en
  servicio. Comprobado.

  `/api/salud` responde 200 mientras el proceso sirva, **aunque la API no
  conteste**, e informa del estado de la API en el cuerpo. Si la tienda se
  declarara enferma cada vez que la API se reinicia, un despliegue normal de la
  API tiraría también la tienda: un incidente de un servicio se convertiría en
  dos.

`worker` no tiene sonda porque no habla HTTP. Que esté vivo se ve en la métrica
de retraso de la cola, no en un puerto.

## 7. Dar de alta al primer cliente

No hay endpoint, y es deliberado: sin autenticar sería una puerta abierta, y
autenticado no serviría porque en un despliegue nuevo todavía no existe ningún
usuario. Exigir acceso al proyecto es el nivel de autorización que corresponde a
«dar de alta a un cliente que paga».

```bash
railway run --service api -- node dist/database/provision.js \
  --nombre "Pollería El Buen Sabor" \
  --email duena@polleria.pe \
  --nombre-dueno "Rosa Quispe" \
  --plan growth
# la contraseña por entorno, para que no quede en el historial del shell:
#   SAHANA_OWNER_PASSWORD='…'
```

A partir de aquí, todo es igual que en el despliegue de una máquina: configurar
el negocio por archivo, emparejar tablets, poner las tiendas en su dominio. Está
en `docs/34-puesta-en-marcha.md` §5 a §8, y no se repite aquí para que no haya
dos versiones que se contradigan.

### Un negocio de demostración, para ver el sistema andando

`infra/railway/semilla-demo.json` es un servicio desechable —mismo patrón que el
arranque de roles— que ejecuta `seed-shop.js`: deja un negocio completo con
carta, pedidos en marcha, comprobantes emitidos y rechazados, un cobro, reparto
y analítica. Sirve para comprobar el despliegue de punta a punta antes de que
haya un cliente de verdad.

Necesita `SHOP_HOST` con el dominio donde se sirve la tienda. **Rehace el
negocio desde cero en cada ejecución**, así que no se apunta a una base con
clientes reales: un `host` es único globalmente y el guion borra el anterior
para poder recrearlo.

Al terminar, borrar el servicio.

## 8. Dominios de cliente

El tenant de cada tienda sale del `Host` y de nada más. En Railway:

1. Declarar el dominio en el archivo de negocio (`tienda.host`).
2. Añadirlo como **custom domain** del servicio `web` y apuntar el DNS del
   cliente al `CNAME` que indica Railway.

Railway conserva el `Host` original, así que no hay nada que configurar en el
proxy. En otros proveedores sí: si el proxy reescribe el `Host`, **todas las
tiendas resuelven a la misma marca**. Es el fallo más caro posible aquí y es
silencioso, porque la página carga.

## 9. Copias de seguridad

Railway hace copias del Postgres según el plan. **Compruébalo antes de tener un
cliente vendiendo**, y prueba una restauración a una base nueva: una copia que
nadie ha restaurado nunca no es una copia, es una carpeta.

Lo mínimo, además: `railway run --service postgres -- pg_dump` a un
almacenamiento que **no** sea Railway. Que las copias vivan en el mismo
proveedor que los datos es lo que convierte un problema de facturación en una
pérdida de datos.

## 10. Lo que este despliegue todavía no da

- **Réplica de lectura y failover.** Un Postgres. Si se cae, se cae todo.
- **Escalado horizontal del worker.** Los trabajos son idempotentes vía `inbox`,
  pero no se ha probado con más de una réplica. No la subas sin medir.
- **Región.** Elegir la más cercana a Perú reduce latencia; ninguna está en
  Perú, así que el POS sigue siendo la ruta rápida para cobrar — y cobra sin
  internet, que es el punto.
