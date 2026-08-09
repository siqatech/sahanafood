# ADR-0019 — La PWA del POS/KDS se construye con Vite, no con Next.js

| Campo | Valor |
|---|---|
| Estado | Propuesto |
| Fecha | 9 de agosto de 2026 |
| Decide | Construir `apps/pos` como **SPA con Vite + React**, con service worker propio e IndexedDB, en vez de reutilizar Next.js |
| Revisar si | (a) el POS pasa a necesitar SEO o renderizado en servidor (no debería: es una herramienta interna); (b) mantener dos cadenas de construcción cuesta más de lo que ahorra; (c) Next.js publica un modo de exportación estática con service worker propio que cubra el caso offline sin rodeos |

## Contexto

CLAUDE.md prohíbe introducir bibliotecas centrales sin ADR, y ADR-0006 ya fijó
el stack: TypeScript, NestJS, Next.js, React. Lo que ADR-0006 **no** decidió es
con qué se empaqueta la PWA del POS; solo dijo «PWA en React». Este ADR cierra
esa parte.

El POS y el KDS tienen un requisito que ninguna otra superficie del proyecto
tiene: **funcionar sin internet durante un servicio completo**. No «degradar
elegantemente»: vender, cobrar, imprimir y encolar veinte pedidos con el router
apagado, y sincronizarlos idénticos al reconectar (T4.21, RN-T07). Eso implica:

- **Todo el código y el catálogo en disco del dispositivo**, servidos por un
  service worker que controla la caché de la aplicación entera.
- **IndexedDB** como almacén de la cola de ventas y del catálogo publicado.
- **Cero llamadas al servidor en el camino de la venta.** El total lo calcula
  `@sahana/domain` en el dispositivo (ADR-0006 §3.2).

## Decisión

`apps/pos` es una **aplicación de una sola página** construida con **Vite** y
React, sin servidor propio: se sirve como archivos estáticos y todo lo demás
ocurre en el navegador de la tablet.

## Alternativas consideradas

### Next.js, como `apps/web`

Sería una cadena de construcción menos. Se descarta por tres motivos concretos,
no por preferencia:

1. **Next.js es un framework de servidor y el POS no tiene servidor.** Sus dos
   piezas más valiosas —componentes de servidor y acciones de servidor— son
   exactamente lo que aquí no se puede usar: cada una es una llamada de red en
   el camino crítico. Se acabaría escribiendo una aplicación de cliente entera
   dentro de un framework que cobra su complejidad por lo que no se usa.
2. **El service worker sería una pelea, no una funcionalidad.** Next trae su
   propio control de la carga de fragmentos; superponerle un service worker que
   sirva la aplicación completa desde caché obliga a duplicar su manifiesto de
   compilación y a mantenerlo sincronizado a mano. Un fallo ahí no se ve en
   desarrollo: se ve la primera vez que una tablet arranca sin red.
3. **`output: 'export'` deja fuera lo que el panel sí usa.** Si el POS se
   exportara estáticamente, `apps/web` no podría compartir la misma
   configuración, y tendríamos dos Next distintos — que es justo la duplicación
   que esta alternativa quería evitar.

### Aplicación nativa (Flutter, React Native)

Ya la descartó ADR-0006 §3.2 y por la razón más fuerte del proyecto: el total de
un pedido se calcularía **dos veces en dos lenguajes**, y divergirían. En Perú
un total divergente no es un bug, es un comprobante electrónico incorrecto.

### Sin bundler, con módulos nativos del navegador

Funciona para una demo. No para cargar `@sahana/domain` desde el monorepo,
generar el manifiesto de precarga del service worker ni producir un paquete que
una tablet de gama media arranque rápido.

## Consecuencias

**A favor**

- El camino de la venta no toca la red **por construcción**: no hay servidor al
  que llamar.
- El service worker y el manifiesto de precarga los genera la propia
  compilación, así que «qué hay en caché» no es una lista que alguien mantiene.
- `@sahana/domain` se consume igual que en el servidor y en la tienda: un solo
  cálculo de totales, que es la garantía de ADR-0006.

**En contra, y hay que decirlo**

- **Dos cadenas de construcción** en el repositorio: Next para `apps/web`, Vite
  para `apps/pos`. Es el precio real de esta decisión.
- **Sin renderizado en servidor**: la primera carga descarga la aplicación
  entera. En una tablet de local, que la instala una vez y la usa meses, es un
  coste que se paga el primer día; en la tienda del cliente sería inaceptable, y
  por eso la tienda **no** se construye así.
- El KDS de la vista TV (`specs/ux/02-kds.md`) tampoco tendrá SEO. No lo
  necesita: es una pantalla colgada en una cocina.

## Cómo se comprueba

- La compilación de `apps/pos` entra en `pnpm build` y en CI.
- El presupuesto de JavaScript se mide como en la tienda: una tablet de gama
  media es el objetivo, no un portátil.
- La prueba que decide si esta decisión valió la pena es la de T4.21: **veinte
  pedidos sin red, veinte en el servidor, totales idénticos** — con el cálculo
  hecho en el dispositivo por `@sahana/domain`.
