# Requisitos no funcionales (SLO iniciales)

Medibles y verificados en pruebas de carga antes de cada salida a producción.

| Área | Objetivo MVP | Objetivo escala regional |
|---|---|---|
| Latencia API p95 (lecturas) | < 300 ms | < 200 ms |
| Latencia API p95 (crear/transicionar pedido) | < 500 ms | < 400 ms |
| Ingesta de webhook (ack) | < 250 ms (encolar, no procesar) | igual |
| Pedido de marketplace visible en KDS | < 5 s | < 3 s |
| Cambio "agotado" propagado a canales | < 60 s | < 30 s |
| Throughput de diseño | 2 000 pedidos/hora sostenidos, pico 10× por 15 min | 50 000/h |
| Disponibilidad API | 99.5% mensual | 99.9% |
| Disponibilidad de venta en local | 100% con POS offline (independiente de la nube) | igual |
| RPO | ≤ 5 min (WAL + PITR) | ≤ 1 min |
| RTO plataforma | ≤ 4 h | ≤ 1 h |
| RTO venta en local | 0 (modo offline) | 0 |
| Retención de auditoría | 5 años | igual |
| Presupuesto de error | 0.5% mensual; si se agota, se congelan features y se prioriza estabilidad | 0.1% |

Perfil de carga de referencia para pruebas: pico de almuerzo 12:00–14:30 y cena 19:00–22:00, 70% del volumen diario en esas ventanas; campaña puede duplicar el pico.
