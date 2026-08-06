# Integraciones

Toda integración pasa por la plataforma de conectores (spec 13). Regla del encargo: NO inventar APIs; estado real documentado.

| Proveedor | Estado real (verificado 05-08-2026) | Requisito |
|---|---|---|
| Rappi | API partners (dev-portal.rappi.com): OAuth2 client-credentials, menú, disponibilidad, pedidos, webhooks. NO autoservicio: aprobación comercial + certificación (exigen ~98% éxito, límites de frecuencia) | Convenio comercial. Iniciar trámite en F4 |
| PedidosYa (Delivery Hero) | POS Middleware API + Plugin API (integrar.pedidosya.com): NDA + confirmación de contacto PY, whitelisting de IPs, vendor de prueba | Convenio comercial |
| Uber Eats | API pública de integración existe; presencia comercial en Perú limitada | Validar por país |
| Agregadores (Deliverect/Otter) | Alternativa de un solo convenio para N canales; costo por local/volumen | Cotizar en F5 como plan B |
| WhatsApp Cloud API | Pública. Precios por mensaje; cambios 01-08-2026 y 01-10-2026 (mensajes de servicio pasan a cobrarse) | Cuenta Meta Business verificada. Métrica mensajes/pedido obligatoria |
| Pasarelas (Culqi/Izipay/Niubiz/MercadoPago) | APIs públicas con sandbox; Yape/Plin vía pasarela | Adaptador por proveedor; credenciales por tenant |
| OSE/PSE (SUNAT) | APIs de proveedores autorizados; exime homologación propia | Cotizar 3 proveedores (decisión pendiente DP-02) |

## Simulador de marketplace (F4, obligatorio)
Servicio interno que emula: envío de pedido por webhook firmado, reintentos duplicados, cancelaciones, cambios de estado, payloads malformados y picos. El orquestador se desarrolla y se prueba de carga contra el simulador ANTES de tocar una API real. Reduce a días la certificación posterior.
