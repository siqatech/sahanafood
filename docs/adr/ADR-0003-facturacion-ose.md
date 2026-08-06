# ADR-0003 — Facturación electrónica delegada a OSE/PSE

Estado: Propuesto · Fecha: 2026-08-05

## Decisión
Emitir vía API de un OSE/PSE autorizado por SUNAT (exime homologación propia; el PSE firma con su certificado). Adaptador intercambiable `BillingProvider`. Cola `documents` con envío diferido para ventas offline. Comprobantes XML/PDF en almacenamiento WORM 5 años.

## Alternativas
Emisión propia UBL 2.1 + homologación (rechazado MVP: componente regulado de mantenimiento perpetuo que no diferencia el producto). Reevaluable a escala por costo por comprobante (disparador: costo OSE > 8% del ingreso del plan).

Pendiente: DP-02 (3 cotizaciones).
