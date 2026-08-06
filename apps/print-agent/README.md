# apps/print-agent — Agente local de impresión (Node, ESC/POS)

Placeholder. Se implementa en la Fase 4 (ADR-0008). Servicio Node que corre en
el local del cliente, con cola propia y reintentos, y habla ESC/POS con las
impresoras térmicas (un navegador no puede). El POS se comunica por HTTP a
localhost. Ni el corte de internet ni el de luz (UPS) detienen la venta.
