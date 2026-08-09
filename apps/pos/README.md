# apps/pos — POS + KDS (PWA offline-first)

Punto de venta y pantalla de cocina, en una sola PWA (ADR-0019).
`specs/ux/01-pos.md` y `specs/ux/02-kds.md`.

```bash
pnpm --filter @sahana/pos dev       # http://localhost:3002
pnpm --filter @sahana/pos build
pnpm --filter @sahana/pos test
```

La API se toma de `VITE_SAHANA_API_URL` (por defecto `http://localhost:3000`).

## Lo que hay que entender antes de tocar esto

**Cobrar no llama al servidor.** Ni una vez. La venta se calcula con
`@sahana/domain` en el dispositivo, se encola en IndexedDB y se sincroniza
cuando hay red. Un POS que necesita al servidor para cerrar una venta deja de
cobrar cuando se cae el router, y en un local eso es cerrar la caja.

**Se vende siempre de la carta descargada**, también con internet. No es un
atajo: hace que el comportamiento con red y sin red sea el mismo. Si con red se
vendiera de una respuesta fresca, el modo offline sería un camino distinto que
solo se ejercita cuando algo falla — y esos caminos siempre están rotos.

**Una venta encolada no se descarta nunca.** Se borra del dispositivo
*después* de que el servidor confirme, jamás antes. Perder una venta cobrada no
se recupera de ninguna parte.

## Cómo se pone en marcha una tablet

1. En el panel, alguien con `users.write` emite un **código de emparejamiento**.
2. La tablet abre la PWA, escribe el código y se queda emparejada para siempre
   (guarda su `deviceToken`).
3. El cajero se elige de la lista y teclea su **PIN**. El dispositivo dice
   *dónde* se vende; el PIN, *quién* vende.

## Lo que todavía NO está

- **Deshacer en el KDS** (DT-11): la API solo sabe avanzar tickets.
- **Cierre de caja por denominación**: la API de caja existe (`/cash-sessions`),
  falta la pantalla de conteo.
- **Impresión**: el `print-agent` está, falta encolarle la comanda desde aquí.
- **Modo TV del KDS** (kiosk sin sesión) y sonidos por canal.
