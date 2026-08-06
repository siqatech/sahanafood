# apps/pos — POS + KDS (PWA offline-first)

Placeholder. Se implementa en la Fase 4. PWA en React con IndexedDB, cola local
cifrada e IDs ULID (sincronización idempotente). **Reutiliza `@sahana/domain`**
para calcular totales/IGV de forma idéntica al servidor: es la defensa contra
comprobantes SUNAT divergentes (ADR-0006, ADR-0008). Imprime vía `print-agent`.
