# Fase 4 — Operación principal
Objetivo: una dark kitchen multimarca opera su día completo con Sahana.
Alcance: Catalog completo · Ordering (spec canónica) · POS PWA offline + print-agent v1 · Cash · KDS por estación · Inventory (recetas+consumo) · Billing con OSE sandbox · WhatsApp notificaciones · Analytics básico · SIMULADOR de marketplace · pruebas de carga k6.
Salida: E2E "día de operación": apertura de caja → 30 pedidos mezclando POS/simulador/programados → 2 cortes de internet → cierre cuadrado, comprobantes emitidos, stock consistente, timeline completo por pedido · carga: pico 10× 15 min sin pérdida (outbox=pedidos, DLQ=0) · offline: suite bloqueante de 06-pos-cash en verde · print-agent instalado desde instalador en máquina limpia.
Deuda permitida: capacidad dinámica de cocina (pasa a F5), UI de bandeja de excepciones básica.
