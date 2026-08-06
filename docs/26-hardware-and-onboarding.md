# Hardware, red del local y onboarding

## Kit de hardware recomendado (realidad peruana)
Homologar y documentar contra equipos que la gente YA compra en Lima (Wilson / Mercado Libre), no contra hardware premium:

| Pieza | Recomendado | Notas |
|---|---|---|
| Tablet POS | Android 10", 4 GB RAM (Samsung Tab A / Lenovo M10 o similar) | La PWA debe volar en esto: presupuesto de rendimiento probado en gama media |
| Pantalla KDS | Tablet 10"+ o TV Android + navegador kiosk | Soporte de pared/grasa; probar legibilidad a 2 m |
| Impresora térmica | 80 mm red/USB genérica (clones Epson TM-T20 chinos: Xprinter, Bixolon) | El print-agent debe hablar ESC/POS genérico; matriz de compatibilidad publicada y creciente |
| Cajón de dinero | RJ11 conectado a la impresora | Se abre por pulso de la impresora (comando estándar) |
| Mini PC / laptop vieja | Cualquier x86 con Windows 10+ o Linux | Corre el print-agent; puede ser la misma máquina del panel |
| Router propio | Router dedicado para el local (no el del internet del centro comercial) | Red local estable: POS↔print-agent↔KDS hablan aunque caiga internet |
| UPS pequeño | 650 VA para router + print-agent + impresora | Cortes de luz ≠ cortes de venta (tablets tienen batería) |
| Balanza / lector | Fuera de MVP | Registrar interés en entrevistas |

Regla de diseño derivada: **la red local es un sistema en sí.** POS, KDS y print-agent deben descubrirse y operar en LAN sin internet (el KDS del punto lee del estado ya sincronizado; ADR-0008). Documentar la topología recomendada con diagrama de un solo router.

## Onboarding del tenant: métrica = primera venta real < 1 día
El churn temprano de POS se decide en el onboarding, no en las features. Flujo obligatorio (F4–F5):
1. **Alta guiada** (wizard): negocio → marcas → local → cocina → estaciones con plantillas por rubro (pollería, hamburguesas, sushi, cafetería) que precargan estaciones y categorías típicas.
2. **Importador de carta:** pegar desde Excel/CSV con mapeo asistido; v1: subir foto/PDF de la carta y extraer productos y precios con IA para revisar y confirmar (nunca publicar sin revisión humana).
3. **Asistente de impresoras:** el print-agent escanea USB/red, imprime página de prueba con un botón, asigna impresora↔estación arrastrando.
4. **Modo práctica:** datos demo descartables con un botón "borrar práctica y empezar en serio" (borra ventas demo, conserva catálogo).
5. **Checklist de salida en vivo:** caja configurada · comprobante de prueba emitido en sandbox OSE · comanda impresa · primer producto con receta (opcional) · usuario cajero con PIN creado. Al 100% → botón "Abrir el local".
6. **Migración desde otro sistema:** plantillas de import específicas (Restaurant.pe, Loyverse, Excel libre) según lo que digan las entrevistas DP-08.

## Soporte como producto
- Botón de ayuda en POS/panel → **WhatsApp de soporte** (el mismo canal que vendemos; comemos nuestra propia cocina), con contexto adjunto automático (tenant, local, versión, últimos errores) previa confirmación del usuario.
- **Página pública de estado** (status.sahana...) con incidentes y postmortems resumidos: la confianza se construye antes del primer incidente.
- **Exportar todo** (catálogo, ventas, clientes, kardex) en CSV desde el panel sin pedir permiso a nadie: la ausencia de lock-in es argumento de venta contra los incumbentes.
- Historial de cambios visible en el panel ("Novedades") con lenguaje de operador, no de developer.

## Métricas de producto (instrumentar desde F4)
Activación: tiempo alta→primera venta real · % de tenants que completan checklist · Adopción semanal por módulo (caja cerrada, receta creada, canal propio activo) · Mensajes WhatsApp/pedido (costo) · NPS operativo trimestral a dueños y cajeros por separado · Retención a 90 días por cohorte y por rubro.
