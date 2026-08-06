# ADR-0001 — Monolito modular con bus de eventos interno

Estado: Propuesto · Fecha: 2026-08-05

## Decisión
Un solo despliegue NestJS con módulos de frontera estricta (API pública por `index.ts`, esquema de tablas propio, dependency-cruiser en CI). Eventos internos vía outbox (ADR-0007). Sin microservicios en F3–F6.

## Alternativas
Monolito tradicional (rechazado: sin fronteras), microservicios (rechazado: costo operativo > beneficio con equipo ≤4 y volumen MVP), eventos como arquitectura separada (adoptado como patrón interno, no como topología).

## Consecuencias
+ Velocidad, transacciones simples, extraíble después. − Exige disciplina → se compensa con verificación automática. Camino de extracción medido: ingestor → tiempo real → analítica.

Revisar si: p95 orquestador > 400 ms sostenido por CPU; equipo > 8; despliegues se bloquean entre equipos.
