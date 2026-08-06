# Personas y actores

| Actor | Interfaz | Necesita | Restricción clave |
|---|---|---|---|
| Propietario | Web/móvil | Rentabilidad por marca/canal, configuración | Acceso total a su tenant |
| Administrador | Web escritorio | Configurar todo | Ámbito: empresa |
| Supervisor | Web/tablet | Monitorear, ajustar capacidad, resolver incidencias | Ámbito: locales asignados |
| Cajero | POS táctil | Vender, cobrar, cerrar caja | Sesión por PIN, sin acceso a config |
| Cocinero | KDS | Cola de su estación, marcar avance | Solo lectura de pedidos, escritura de estados de preparación |
| Empacador | Estación despacho | Verificar, etiquetar por marca | — |
| Repartidor | PWA móvil | Asignaciones, ruta, evidencia, cobro contra entrega | Solo sus envíos |
| Operador call center | Web | Captura rápida de pedidos | — |
| Contador | Web | Ventas, comprobantes, conciliación | Solo lectura |
| Soporte Sahana | Herramienta interna | Diagnóstico, impersonación controlada | Toda acción auditada; requiere motivo |

Sistemas externos: pasarela de pago, OSE/PSE, WhatsApp Cloud API, marketplaces (simulados hasta F7).
