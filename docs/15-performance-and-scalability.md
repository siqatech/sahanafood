# Rendimiento y escalabilidad

SLOs en docs/06. Estrategias:

- **Caché** (Redis): catálogo resuelto por (marca, canal, local) TTL 60 s + invalidación por evento `catalog.*`; sesiones; configuración de tenant. Nunca cachear pedidos ni stock.
- **Índices:** todos los calientes comienzan por `tenant_id`. Revisión de `pg_stat_statements` semanal; presupuesto: ninguna consulta de request > 50 ms p95.
- **N+1:** prohibido por revisión + tests de conteo de queries en endpoints listados.
- **Asíncrono:** todo lo que no necesita respuesta inmediata va a cola (facturación, notificaciones, propagación de disponibilidad, reportes).
- **Backpressure:** si `critical` supera profundidad umbral → el orquestador extiende tiempos prometidos y KDS lo refleja; si sigue → pausa automática de canales de menor margen (política por tenant).
- **Resiliencia a terceros:** timeout 5 s, circuit breaker por conector (abre a 50% error/30 s), bulkhead por proveedor (pool de workers separado), reintentos con backoff+jitter solo en operaciones idempotentes.
- **Réplica de lectura:** a partir de F6 para reportes; analítica (F8) lee de réplica o de proyecciones, nunca del primario.
- **Pruebas de carga:** k6 contra el simulador de marketplace + generador de tráfico de tienda; perfil de picos de docs/06; obligatorias en el gate de F4, F5 y F7. Soak de 24 h antes de GA.
- **Imágenes:** redimensionado a variantes en worker, WebP/AVIF, CDN, presupuesto < 200 KB por imagen servida.
