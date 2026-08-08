# ADR-0017 — Tokens públicos de acceso acotado

| Campo | Valor |
|---|---|
| Estado | **Propuesto** |
| Fecha | 8 de agosto de 2026 |
| Depende de | ADR-0002 (multi-tenant con RLS), ADR-0014 (escapes acotados), ADR-0016 (webhook de pasarela) |
| Tareas | T5.05 (links de pago), T5.16 (tracking público) |
| Revisar si | Aparece un caso que necesite que el token AUTORICE escritura de negocio, o si el pentest de F5 cuestiona el patrón |

## Contexto

ADR-0016 cerró con una advertencia explícita:

> Es el **cuarto** escape acotado. El patrón deja de ser excepcional y pasa a ser
> un mecanismo del sistema. Si apareciera un quinto, la conversación ya no es
> «añadimos otro» sino «hace falta un mecanismo de primera clase».

Apareció el quinto, y de golpe aparecieron dos:

1. **Links de pago** (T5.05). Un agente genera un link y se lo manda al cliente
   por WhatsApp. El cliente lo abre sin haber iniciado sesión —no tiene cuenta—
   y hay que resolver de qué tenant es antes de poder enseñarle nada.
2. **Tracking público del pedido** (T5.16). La spec 09 lo pide sin
   autenticación y con datos mínimos: «estado + ETA, sin datos personales del
   repartidor más que el nombre de pila».

Y se ven venir más: recuperación de carrito, encuestas post-pedido, confirmación
de correo. Todos con la misma forma —una URL que llega a alguien sin cuenta y
que tiene que resolver un tenant— y todos con la misma tentación: añadir una
columna `algo_token` a la tabla del recurso y otra política de escape.

Ese camino termina mal de una forma concreta: **cada escape nuevo es una tabla
de negocio más que puede leerse sin contexto de tenant**, y la frase que
sostiene la seguridad de ADR-0014 («ninguna tabla de negocio menciona el flag»)
se vuelve falsa por acumulación, sin que ninguna decisión individual parezca
mala.

## Decisión

Una tabla única, `pub_tokens`, y **un solo escape** —`app.public_token`— que
sirve a todos los casos presentes y futuros.

```
pub_tokens(token, tenant_id, purpose, resource_type, resource_id,
           expires_at, revoked_at, used_at, created_by)
```

Cinco restricciones, y son la decisión:

1. **El token no lleva datos, lleva una referencia.** Resolverlo dice
   «este token es del tenant T, sirve para el propósito P, sobre el recurso R».
   Nada más. El contenido se lee después, con `withTenant(T)`, por el código del
   módulo dueño del recurso.
2. **Acotado por propósito.** `purpose` es un enum cerrado
   (`payment_link`, `order_tracking`, …). Un token de tracking presentado en la
   ruta de pago no resuelve: el llamador declara qué propósito espera y el
   resolutor lo comprueba. Sin eso, un token filtrado en un sitio abriría todos
   los demás.
3. **Caduca siempre.** `expires_at` es NOT NULL. No hay tokens públicos
   eternos: un enlace que circula por WhatsApp durante meses acaba en un grupo
   que no es el que era.
4. **Solo lectura de esta tabla.** La política de escape es `FOR SELECT` sobre
   `pub_tokens` y nada más. Ninguna tabla de negocio menciona el flag — que es
   exactamente la frase que había que preservar.
5. **Resolver no es autorizar.** Igual que en ADR-0014 y ADR-0016. Lo que el
   token concede lo decide el módulo dueño, y se decide **por propósito**, no
   por tener un token válido.

### Lo que NO hace

- **No sustituye a la sesión.** Un token público jamás da acceso al panel ni a
  operaciones de tenant. Solo abre lo que su propósito describe.
- **No escribe datos de negocio por sí mismo.** Un link de pago lleva a pagar
  —y quien confirma sigue siendo el webhook firmado (RN-PAY-01)—, no marca nada
  como pagado.
- **No sirve para recursos de otro tenant.** El tenant sale del token, no del
  parámetro; es la misma regla de siempre.

### `used_at` y por qué el link de pago NO es de un solo uso

`used_at` registra la primera apertura, para poder medir y para poder revocar.
**No bloquea la segunda.**

Es una decisión de producto tomada a conciencia y en contra de la primera
redacción del backlog, que decía «link de un solo uso». Un link de pago que
muere al abrirse falla así: el cliente lo abre, le suena el teléfono, cierra la
pestaña, y la venta se pierde porque el enlace ya no vale. El beneficio de
seguridad es pequeño —el token sigue caducando y sigue atado a un cobro
concreto, que no se puede pagar dos veces— y el coste es una venta perdida cada
vez que alguien se distrae.

Lo que sí es de un solo uso es el COBRO: una intención pagada ya no admite otro
pago, y eso lo garantiza la máquina de estados de ADR-0016, no el link.

## Alternativas rechazadas

- **Un escape por caso** (`app.payment_link_lookup`,
  `app.tracking_lookup`, …). Rechazado: es la acumulación que ADR-0016 avisó que
  no había que dejar crecer. Con dos casos ya son seis escapes y seis políticas
  que auditar.
- **JWT firmado sin tabla**, con tenant y recurso dentro. Tentador —cero
  consultas— y rechazado por una razón práctica: **no se puede revocar**. Un
  link de pago que se manda al cliente equivocado, o un tracking que acaba en
  redes sociales, tiene que poder cortarse hoy y no cuando caduque.
- **Reutilizar `int_connections`/`pay_connections`.** Rechazado: son
  credenciales de sistemas externos, no enlaces para clientes finales; mezclarlo
  confunde dos ciclos de vida muy distintos.

## Consecuencias

- **+** El número de escapes deja de crecer con los casos de uso: queda fijo en
  cinco (`app.system`, `app.auth_lookup`, `app.integration_lookup`,
  `app.payment_lookup`, `app.public_token`), y el quinto absorbe a todos los
  futuros de este tipo.
- **+** Revocar, caducar y auditar enlaces públicos se hace en un solo sitio.
- **+** T5.16 (tracking) ya no necesita decisión propia: usa este mecanismo.
- **−** Una indirección más: resolver el token es una consulta antes de la
  consulta real. Es el precio de no repartir la puerta de atrás por diez tablas.
- **−** `pub_tokens` se convierte en un objetivo interesante. Mitigación: 32
  bytes de entropía, índice único, caducidad obligatoria, y **área explícita del
  pentest de F5** junto con los otros cuatro escapes, revisados como familia.
