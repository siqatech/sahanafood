# UX: Tienda (apps/web, canal propio)
> Usuario: cliente final con hambre, gama media/baja, datos móviles. Fase 5.

## Presupuestos duros
LCP < 2.5 s en 4G real · JS < 200 KB en catálogo · imágenes WebP/AVIF responsive < 150 KB · Lighthouse móvil ≥ 85 (gate F5).

## Flujo: ≤ 4 pantallas
1) Catálogo (dirección arriba para resolver local/zona temprano; categorías sticky; foto+nombre+precio; badges "más pedido") → 2) Producto/modificadores (misma lógica @sahana/domain que POS) → 3) Carrito (revisión, cupón, propina opcional) → 4) Checkout (invitado por defecto: nombre+teléfono+dirección con mapa; pago pasarela o contra entrega). Confirmación con nº corto + link de tracking + botón "guardar mi pedido en WhatsApp".

## Detalles
- Dirección primero resuelve el problema nº1 (¿me atienden? ¿cuánto el envío?) antes de enamorar con la carta.
- Agotado entre carrito y pago: aviso específico con reemplazo sugerido, nunca error genérico (RN-STO-02).
- Horario cerrado: mostrar carta igual + "abre a las 12:00" + pedido programado si está activo.
- Tracking público: estados humanos ("En cocina", "Empacando", "En camino — Jorge"), mapa solo si hay tracking real, sin datos sensibles.
- Marca blanca real: colores/logo/dominio del tenant; "con Sahana" discreto en el pie (configurable por plan).
- SEO: SSR, schema.org Restaurant/Menu, OG por marca.
