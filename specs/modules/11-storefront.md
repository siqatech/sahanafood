# Módulo: Storefront (tienda web)
> Fase: 5 · Depende de: Catalog, Ordering, Payments, Delivery

## Alcance
Tienda por marca (Next.js multi-tenant por dominio/slug), catálogo resuelto por (marca, canal=web, local según zona), carrito, invitado o registro, delivery/recojo/programado, cupones (v1), checkout con pasarela del tenant o contra entrega, tracking, SEO básico, Core Web Vitals móviles.
## Reglas
RN-STO-01 Resolución de local: por zona de la dirección del cliente; sin cobertura → recojo o lista de espera. RN-STO-02 Carrito valida disponibilidad al agregar Y al confirmar (producto agotado entre medio → aviso claro, no error genérico). RN-STO-03 Dominio propio por marca: CNAME + certificado automático; fallback subdominio sahana. RN-STO-04 Invitado: solo datos mínimos; consentimiento marketing explícito y separado (RN-T10).
## Pruebas
Agotado entre carrito y checkout · zona sin cobertura · pago fallido → carrito recuperable · Lighthouse móvil ≥ 85 en catálogo y checkout · aislamiento por dominio (marca A no sirve catálogo de B).
## Aceptación
Compra completa en ≤ 4 pantallas desde el celular; funciona sin JS pesado en gama baja (presupuesto JS < 200 KB en catálogo).
