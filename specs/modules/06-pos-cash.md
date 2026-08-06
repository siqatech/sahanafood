# Módulo: POS y Caja
> Fase: 4 · ADRs: 0006, 0008, 0010 · Depende de: Catalog, Ordering, Identity

## Alcance
PWA de venta (offline-first), sesiones de caja, arqueo, medios de pago locales (efectivo, tarjeta-en-POS-físico, Yape/Plin QR referencial), pago mixto, propinas, descuentos con PIN, integración con print-agent. NO: pagos online (Payments), emisión SUNAT (Billing, se invoca).
## Reglas
RN-POS-01 No se vende sin sesión de caja abierta. RN-POS-02 Cierre: declarado vs contado; diferencia ≠ 0 exige motivo + PIN supervisor → auditoría. RN-POS-03 Descuento > umbral → PIN supervisor (RN-T08). RN-POS-04 Offline: RN-T07 y ADR-0008. RN-POS-05 Anulación post-cobro = reembolso + NC → flujo Billing, permiso especial.
## Estados de sesión
open → closing (conteo) → closed; movimientos: sale, refund, cash_in, cash_out, tip.
## API
POST /cash-sessions · POST /cash-sessions/:id/close · POST /cash-sessions/:id/movements · (ventas van por POST /orders con channel=pos).
## Pruebas offline (bloqueantes)
Vender 20 pedidos sin red → sincronizar → 20 en servidor, totales idénticos (comparar Money servidor vs PWA) · corte de red a mitad de sync → sin duplicados · cierre con offline pendiente → bloqueado con aviso o sesión de ajuste.
## Aceptación
Demo: día completo de operación con 2 cortes de internet simulados sin pérdida ni descuadre; impresión de comanda y precuenta vía print-agent en ambos estados.
