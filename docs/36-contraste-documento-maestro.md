# Contraste con el Documento Maestro Funcional v1.1

> Qué de ese documento ya está construido, qué no, y qué merece la pena
> incorporar. Comprobado contra el esquema real (82 tablas, `infra/migrations/`)
> y los 19 módulos de `apps/api/src/modules/`, no contra las specs — lo que
> interesa aquí es lo que **existe**, no lo que está descrito.

El documento es de descubrimiento («no representa todavía el alcance cerrado del
MVP», dice su propia ficha) y su inventario de 117 capacidades es más ancho que
nuestro MVP a propósito. Sirve entonces para una cosa concreta y valiosa:
**usarlo como lista de comprobación de cobertura**. Lo que sigue es el resultado
de pasarla.

Conclusión corta: de las 117, **61 están construidas**, 9 están parciales, 47 no
existen — y de esas 47, **41 son alcance planificado de F6/F7 o descartado a
conciencia**. Quedan **seis** hallazgos que sí cambian algo, y de ellos uno es
serio.

---

## 1. Lo que confirma

Las 21 capacidades marcadas P0 en el documento —el «core arquitectónico»— están
todas construidas menos una, y sus principios de diseño coinciden con los
nuestros sin haberse copiado: *order-centric*, *modular monolith first*,
*offline-aware*, *audit by design*, *configurable not hardcoded*. Coincidir en
esto tras haberlo decidido por separado es la señal útil del documento.

Construido y verificado: tenancy con planes y límites, locales con horarios y
almacenes, marcas virtuales, usuarios con PIN, roles y permisos, auditoría,
catálogo con variantes y modificadores, combos, disponibilidad por local y
canal, precios por canal, Order Engine, POS táctil, KDS con estaciones, KOT,
printer routing, offline, delivery con zonas y despacho, repartidores,
capacidad de cocina, pagos, caja con arqueo, facturación con OSE, devoluciones,
anulaciones, insumos, UOM, almacenes, stock, movimientos, Kardex, recetas y
subrecetas, food cost, merma, analítica de ventas y de cocina, rentabilidad por
canal y por producto, API, webhooks, hub de integraciones, observabilidad y
configuración.

## 2. Los seis hallazgos

### 2.1 Pagos mixtos — el único P0 que falta, y es real

`ord_orders.payment_method` es **una sola columna de texto**, y el enlace de
pago se crea por el **total** del pedido. Un cobro es todo-o-nada con un medio.

En Perú «S/ 50 en efectivo y el resto por Yape» no es un caso raro: es una forma
corriente de pagar, sobre todo en delivery. Hoy el cajero lo resuelve mintiendo
—anota un medio y cuadra la caja como puede— y eso rompe justo lo que la caja
existe para dar: el cuadre por medio de pago. Toca además la conciliación de
comisiones y el medio declarado en la boleta.

No es un ajuste de pantalla, es el modelo de cobro, así que va como pregunta
abierta **PA-09** y no como algo que se implemente sin decidirlo. La estructura
lo permitiría sin romper nada: `pay_intents` no tiene índice único por pedido.

### 2.2 Stock reservado — una columna que abre tres capacidades

`inv_stock` guarda solo `quantity`. No distingue físico / reservado /
disponible. Para vender basta —el consumo es automático al aceptar (RN-INV-02)—
pero sin `reserved` no se puede comprometer stock para producción anticipada ni
avisar de un faltante **antes** de que el pedido entre, y es la pieza que
faltaría el día que haya lotes y FEFO.

Es barato ahora y caro después: una columna y su invariante, frente a una
migración con datos de clientes vendiendo. **PA-11**.

### 2.3 QR de mesa: barato ahora, caro si se decide tarde

El documento lo marca P1 y nosotros no tenemos nada de salón — deliberadamente:
todas las specs están escritas para un negocio sin mesas. Pero el **QR** no
depende del salón. La tienda ya resuelve la marca por dominio, el carrito existe
y el checkout invitado también; faltaría el contexto de mesa o de local.

Incluso sin salón sirve: pedir desde el propio local sin hacer cola, y recojo.
La decisión de fondo —¿entramos en restaurante con salón o seguimos siendo dark
kitchen + delivery?— es **PA-10**, y conviene tomarla pronto porque cambia el
ciclo de vida del pedido (una mesa tiene varias órdenes), la caja (propina por
mozo) y el POS entero.

### 2.4 Importador CSV: fricción de onboarding, no de producto

Dar de alta un cliente hoy pasa por un JSON (`setup-business.js`). Funciona, es
idempotente y está probado en CI de punta a punta. Pero un dueño con 180
productos en un Excel no escribe JSON, y quien lo escriba por él tardará una
tarde por cliente.

El documento lo lista como P1 (capacidad 114) y tiene razón en el orden de
magnitud: es lo que separa «dar de alta a diez clientes» de «dar de alta a uno».
No es deuda técnica —lo que hay funciona— es coste comercial por cliente.

**Hecho** (`import-csv.js`, runbook §5). Es una transformación de archivos y no
un alta contra la base: produce el mismo `negocio.json` que ya aplica
`setup-business.js`, así que no hay un segundo camino de escritura al catálogo
donde los precios puedan salir distintos, y el resultado se puede revisar antes
de publicarlo. Las hojas de ejemplo reproducen exactamente
`negocio.ejemplo.json`, con lo que el camino del CSV hereda la verificación de
punta a punta que ya tenía el JSON.

### 2.5 Propinas: existen a medias

`ord_orders` acepta `tipMinor` y `cash_movements` tiene el tipo `tip`, así que la
propina entra y cuadra en caja. Lo que no existe es la **liquidación**: a quién
le toca cuánto y cuándo se le paga. Sin salón el asunto es menor (delivery: al
repartidor); con salón es una de las tres cosas que el personal mira. Depende
de PA-10.

### 2.6 P&L completo espera a gastos

`/panel/reportes` da rentabilidad por marca, canal y producto: ingresos menos
comisión menos food cost. Lo que el documento llama **P&L diario** (capacidad
107) necesita además gastos y centros de costo, que son F6. No es un hueco: es
que el margen que enseñamos hoy es de contribución, no de resultado, y la
pantalla debería decirlo para que nadie lo lea como su utilidad.

## 3. Lo que NO conviene tomar del documento

- **MRP, work centers, job cards, downtime, forecasting, homologación de
  proveedores, activos** (capacidades 83-86, 69, 98, 101). Son ERP industrial.
  Meterlos convierte el producto en lo que su propio benchmark identifica como
  el problema a evitar: «reducir la complejidad visual típica de los ERP».
- **Referencias de código.** El documento estudia URY, Odoo, TastyIgniter,
  ERPNext, Floreant y POS Awesome. Todas son GPL/LGPL/AGPL y ADR-0009 lo
  prohíbe: referencia conceptual sí, código no. El propio documento dice «no
  como patrón visual a copiar», que es la lectura correcta.
- **Reviews, wallet, gift cards** (P2/P3). Son producto de fidelización, no
  operación. Antes de eso hay que tener clientes operando un mes.

## 4. Lo que ya sabíamos y el documento confirma

- **Notificaciones** (capacidad 110, P1): es **DT-13**, ya registrada. El
  documento la marca P1 y coincide con nuestro diagnóstico — un aviso que exige
  que alguien esté mirando no es un aviso.
- **CRM/Clientes** (capacidad 10, P1): `specs/modules/14-crm.md` existe y es F6.
  `wa_contacts` es mensajería, no CRM, y la pantalla se llama «Mensajería» justo
  para no prometer lo que no está.
- **Compras y proveedores** (capacidades 90-99): F6 planificado. No es deuda —
  es alcance de fase, como dice la cabecera de `docs/23-technical-debt.md`.
- **Lotes, conteos, transferencias, replenishment** (64-71): F6.
- **Backup/recovery** (115, P0): responsabilidad de despliegue, cubierta en
  `docs/34` §9 y `docs/35` §9.

---

## Qué hacer con esto

Tres preguntas al propietario, por orden de coste de equivocarse tarde:

1. **PA-10** — ¿salón, o dark kitchen + delivery? Es la que decide el producto.
2. **PA-09** — ¿pagos mixtos? Es la que hoy hace que un cajero tenga que mentir.
3. **PA-11** — ¿stock reservado? Es la más barata de las tres si se hace ahora.

El importador de CSV, que era el cuarto punto, ya está hecho.
