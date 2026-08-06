# ADR-0008 — Offline: PWA + agente local de impresión

Estado: Propuesto · Fecha: 2026-08-05

## Contexto
El plan afirmaba "PWA imprime localmente". Es falso: un navegador no habla ESC/POS con impresoras térmicas (USB/red) de forma fiable; Web Serial/USB es parcial e inviable operativamente. Floreant resuelve impresión porque es app de escritorio. Sin corregir esto, el POS offline no existe.

## Decisión
1. El POS sigue siendo PWA (mantiene @sahana/domain compartido, ADR-0006).
2. Se añade **print-agent**: servicio Node instalado en una máquina del local (Windows/Linux), HTTP en localhost con token de emparejamiento, drivers ESC/POS USB y red, cola propia con reintento y reimpresión. La PWA imprime SIEMPRE a través del agente; jamás directo.
3. El agente reporta salud (impresora sin papel/offline) a la PWA y a la nube cuando hay red.
4. Sync offline: IndexedDB + cola cifrada + ULID cliente + reglas de conflicto RN-T07 (venta siempre se acepta; stock negativo con alerta; snapshot de precio prevalece).

## Alternativas
App Electron/Tauri POS completa (rechazado: pierde la distribución simple de PWA; el agente aísla solo el problema real), impresoras "cloud print" (rechazado: dependen de internet — contradice el objetivo), Web Serial (rechazado: soporte y permisos frágiles).

## Consecuencias
+ Offline real con impresión; superficie nativa mínima y sin lógica de negocio. − Un binario que instalar y actualizar (auto-update firmado); un componente más que observar. Es el precio de la continuidad operativa.
