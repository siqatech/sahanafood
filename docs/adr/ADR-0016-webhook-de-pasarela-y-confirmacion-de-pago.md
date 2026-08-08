# ADR-0016 — Webhook de pasarela: cómo se resuelve el tenant y qué confirma un pago

| Campo | Valor |
|---|---|
| Estado | **Propuesto** |
| Fecha | 8 de agosto de 2026 |
| Depende de | ADR-0002 (multi-tenant con RLS), ADR-0010 (idempotencia), ADR-0014 (escapes acotados) |
| Tareas | T5.01, T5.02, T5.03 |
| Revisar si | El pentest de F5 cuestiona el patrón, o si aparece una pasarela que no permita configurar la URL de callback por comercio |

## Contexto

RN-PAY-01 es tajante: **un pedido online se confirma SOLO con webhook de pago
verificado, nunca con el redirect del navegador.** El motivo es viejo y conocido:
el redirect lo controla el cliente. Se puede pegar en la barra de direcciones, se
puede reproducir, y llega antes de que la pasarela sepa si el cargo prosperó.
Confirmar con él es aceptar pedidos que nadie pagó.

Eso obliga a exponer un endpoint que atiende a un desconocido —la pasarela— y que
tiene que averiguar **a qué tenant pertenece el cobro antes de poder verificar
nada**. Es el mismo problema que ya resolvió el webhook de marketplace en T4.14,
y ADR-0014 dejó escrito que había que revisarlo «si aparece un cuarto caso». Este
es el cuarto caso.

Hay una diferencia que lo hace más delicado: aquí hay dinero. Un fallo de
aislamiento en la ingesta de marketplace mete un pedido en la cocina equivocada;
uno aquí **confirma un cobro en el tenant equivocado**.

## Decisión

### 1. El tenant se resuelve por un token opaco en la URL, no por el pago

La ruta es `POST /payments/callbacks/:provider/:token`, con `pay_connections`
—una tabla de credenciales, no de dinero— y un escape `app.payment_lookup`
**solo de SELECT** y **solo sobre esa tabla**, con el mismo patrón acotado de
ADR-0014.

Se rechaza la alternativa evidente —dejar la URL como la escribe la spec 10
(`/payments/callbacks/:provider`) y resolver el tenant leyendo la referencia del
pago dentro del payload— porque exigiría un escape de lectura sobre
`pay_intents`, que es una tabla de negocio **con importes**. ADR-0014 sostiene su
seguridad precisamente sobre lo contrario: «ninguna otra tabla de negocio lo
menciona, así que activar el flag no puede exponer pedidos, catálogo ni cobros de
otro tenant». Abrirlo sobre los cobros vaciaría esa frase de contenido.

**Divergencia registrada respecto de `specs/modules/10-payments-billing.md`:** la
ruta lleva un segmento más que el de la spec. Es realista —las pasarelas del
mercado permiten configurar la URL de notificación por comercio— y es lo que
mantiene el escape sobre credenciales en vez de sobre importes.

### 2. Resolver sigue sin ser autorizar

El escape permite averiguar **de quién es la URL** y obtener el secreto con el
que verificar la firma. Nada más. Token válido con firma inválida = 401 sin
tocar el pago, sin registrar intento contra el pedido y sin revelar si el token
existía.

### 3. El webhook es idempotente por diseño, no por suerte

Las pasarelas reintentan. Todas. Un webhook duplicado no puede confirmar dos
veces un pedido ni cobrar dos veces una comisión, así que la deduplicación va
donde no se puede olvidar: **clave única `(tenant_id, provider, event_id)`** en
la tabla de eventos recibidos, escrita **en la misma transacción** que el efecto
sobre la intención de pago. Es el patrón de ADR-0010 y el mismo que ya usa la
ingesta de marketplace.

Si la pasarela no manda un identificador de evento propio, se deriva uno estable
del contenido (`provider:intent:status`), que es lo que de verdad se quiere
deduplicar: el mismo hecho, no el mismo paquete.

### 4. El estado del pago vive en `pay_intents`, y solo avanza

`pending → authorized → captured` y las salidas `failed`, `expired`,
`refunded`. Las transiciones se validan en `@sahana/domain` igual que las del
pedido, y son **monótonas**: un webhook viejo que llega tarde —cosa que pasa,
porque los reintentos no respetan el orden— no puede devolver un pago capturado
a `pending`. Sin esa regla, el reintento de un webhook de hace diez minutos
desconfirma una venta ya entregada.

### 5. El importe se verifica, no se acepta

El webhook trae un importe. Si no coincide con el de la intención, **no se
confirma**: se marca la discrepancia y se alerta. Aceptar el importe que manda el
otro lado es cómodo hasta el día en que llega uno que no es el que se cobró.

## Alternativas rechazadas

- **Confirmar con el redirect y «verificar después».** Rechazado por RN-PAY-01.
  No es una optimización con un riesgo pequeño: es la vulnerabilidad clásica de
  todo checkout mal hecho.
- **Un endpoint por tenant sin token, distinguido por subdominio.** Rechazado:
  traslada el problema a la capa de DNS y de certificados, donde es más difícil
  de probar y de auditar.
- **Guardar las pasarelas en `int_connections`**, reutilizando el escape de
  integraciones tal cual. Rechazado: ahorra una tabla a cambio de mezclar dos
  conceptos que se listan, se pausan y se auditan por separado. La bandeja de
  canales de venta acabaría mostrando pasarelas de pago.
- **Verificar la firma antes de resolver el tenant.** Imposible: la clave para
  verificar es justamente lo que hay que resolver.

## Consecuencias

- **+** El aislamiento de las tablas con dinero queda intacto: ningún escape las
  menciona.
- **+** La deduplicación no depende de que alguien se acuerde: es una restricción
  de la base de datos.
- **−** Es el **cuarto** escape acotado. El patrón deja de ser excepcional y pasa
  a ser un mecanismo del sistema; conviene que el pentest de F5 lo revise como
  familia y no caso a caso. Si apareciera un quinto, la conversación ya no es
  «añadimos otro» sino «hace falta un mecanismo de primera clase».
- **−** El endpoint es inducible por cualquiera que conozca la URL, igual que el
  de marketplace. Mitigación idéntica: token de 32 bytes, índice único, y una
  firma que el atacante no puede producir. **Área prioritaria del pentest.**
- La respuesta al webhook debe ser rápida (las pasarelas reintentan o marcan el
  endpoint como caído): se persiste y se responde, y el efecto se aplica en la
  misma transacción corta. Si crece, pasa al patrón de la ingesta —ack primero,
  procesar después— que ya está construido.
