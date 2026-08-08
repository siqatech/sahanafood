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
revertir (§7).

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

Devuelve el `tenantId` en JSON. A partir de ahí, todo lo demás —marcas, locales,
carta, dominio de la tienda— se hace desde el panel con esa cuenta.

## 5. Poner la tienda en un dominio

El tenant de cada tienda **sale del `Host`** y de nada más. Los pasos son:

1. En el panel, registrar el dominio de la marca y verificarlo.
2. Apuntar el DNS del cliente al servidor.
3. En el proxy, enrutar ese dominio al puerto `3001` **conservando el `Host`
   original** (`proxy_set_header Host $host` en nginx; Caddy lo hace solo).

Si el proxy reescribe el `Host`, **todas las tiendas resolverán a la misma
marca**. Es el fallo más caro posible aquí y es silencioso: la página carga.

## 6. Copias de seguridad — responsabilidad de quien levanta

En este despliegue Postgres vive en el mismo servidor. **Nadie hace copias por
ti.** Lo mínimo antes de tener un cliente vendiendo:

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env \
  exec -T postgres pg_dump -U "$POSTGRES_SUPERUSER" "$POSTGRES_DB" \
  | gzip > "sahana-$(date +%F).sql.gz"
```

Diario, **fuera de la máquina**, y probando la restauración de vez en cuando:
una copia que nadie ha restaurado nunca no es una copia, es una carpeta.

## 7. Desplegar una versión nueva, y revertirla

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

**No se revierten migraciones.** El esquema se queda por delante, la sonda de
readiness lo da por listo, y eso funciona porque ninguna migración puede romper
a la versión anterior: lo impide el gate `pnpm migrations:check`, que corre en
CI y rechaza `DROP COLUMN`, renombrados, cambios de tipo y `NOT NULL` sin
`DEFAULT`. Las dos piezas son la misma garantía (docs/17, T5.35).

## 8. Qué mirar cuando algo va mal

| Síntoma | Dónde mirar |
|---|---|
| La API reinicia en bucle | `docker logs sahana-api-1`. Casi siempre es configuración: el proceso valida al arrancar y prefiere no arrancar |
| `/health/ready` dice `not_ready` con `database: ok` | El esquema va por detrás de la imagen: falta correr `migrate` |
| Una tienda enseña la carta de otra | El proxy está reescribiendo el `Host` (§5) |
| Los pedidos no llegan a cocina | El worker. `docker logs sahana-worker-1`: al arrancar imprime qué barridos y qué consumidores tiene activos |
| La cola crece | Métricas `outbox_pending` y `outbox_oldest_pending_seconds` (docs/18). Más de 1 000 pendientes es alerta |

## 9. Lo que este despliegue NO trae

Se dice aquí para que nadie lo descubra el día que haga falta:

- **Alta disponibilidad.** Un servidor. Si se cae, se cae todo.
- **Copias gestionadas.** Ver §6.
- **Escalado horizontal.** La API y el worker escalan con réplicas, pero el
  Postgres local no.
- **Canario.** El reparto de tráfico al 10 % necesita balanceador (**DT-02**).
  Lo que sí está: revertir sin tocar la base.
- **Certificados.** Los pone el proxy.
