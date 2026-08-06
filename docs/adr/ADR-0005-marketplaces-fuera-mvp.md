# ADR-0005 — Marketplaces fuera del MVP; simulador obligatorio

Estado: Propuesto · Fecha: 2026-08-05

## Decisión
Rappi/PedidosYa exigen convenio, credenciales manuales y certificación (verificado 05-08-2026): no pueden estar en la ruta crítica del MVP. El orquestador se construye y prueba contra un SIMULADOR interno de marketplace (F4) que emula webhooks firmados, duplicados, cancelaciones y picos. Trámites comerciales inician en F4 en paralelo. Integración real en F7 (o F5 vía agregador si el convenio directo se atasca — DP-03).
