# Offline y resiliencia (ADR-0008)

## Qué funciona sin internet (obligatorio)
Vender en POS · calcular totales (mismo `@sahana/domain`) · imprimir comanda y precuenta vía print-agent · cobrar efectivo y registrar tarjeta-en-POS-físico · abrir/cerrar caja · ver cola KDS local del punto.

## Qué NO funciona offline (aceptado)
Pagos online, tienda web, WhatsApp, marketplaces (los canales cloud siguen operando contra la nube; si la COCINA está offline, la nube acumula y avisa al canal con tiempo extendido), emisión SUNAT en línea (se encola: normativa permite envío diferido; límite operativo configurado y alertado).

## Diseño
- PWA con IndexedDB: catálogo replicado (versionado), cola local de operaciones cifrada (WebCrypto, clave derivada del registro de dispositivo).
- IDs generados en cliente: ULID → sin colisiones, orden temporal.
- Sync: push de operaciones en orden, idempotente (el servidor deduplica por ULID); pull incremental de catálogo/config por `updated_at` + versión.
- **Conflictos (reglas fijas, RN-T07):** venta offline SIEMPRE se acepta · precio: prevalece snapshot offline para ese pedido; alerta si difiere del vigente · stock: puede quedar negativo, alerta `stock.negative` · caja: los movimientos offline entran a la sesión abierta; si el cierre ocurrió, se abre sesión de ajuste con auditoría.
- **print-agent:** servicio Node local (instalador para Windows/Linux), expone HTTP en localhost con token de emparejamiento, driver ESC/POS (USB/red), cola de impresión propia con reintento, botón de reimpresión. La PWA nunca habla con la impresora directamente (limitación real del navegador; lección de Floreant).
- Modo degradado por dependencia: WhatsApp caído → notificar por SMS/email fallback y seguir; pasarela caída → ofrecer contra entrega; OSE caído → encolar documentos; marketplace caído → circuit breaker + aviso.

## Recuperación
Reconexión automática con backoff; indicador de estado visible en POS (online/offline/sincronizando, nº pendientes); panel de operaciones pendientes > 30 min → alerta al supervisor.
