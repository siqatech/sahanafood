# UX y sistema de diseño

Regla madre: **cada superficie tiene un usuario, un contexto físico y un estado emocional distintos.** El POS se usa bajo presión con las manos ocupadas; el KDS se lee a 2 metros entre vapor; el panel se consulta desde la cama a las 11 pm; la tienda la usa un cliente con hambre y datos móviles. Diseñar una sola UI para todos es diseñar mal para todos.

## Principios (aplican a todo)
1. **Latencia percibida < 100 ms:** toda acción da feedback inmediato (optimistic UI + reconciliación). La red nunca bloquea el toque; si algo falla después, se avisa y se ofrece reintento.
2. **Cero estados vacíos muertos:** todo vacío dice qué hacer a continuación con un botón ("Aún no tienes productos → Importar carta").
3. **Errores con acción, en español claro:** nunca códigos crudos. Patrón: qué pasó + qué hacer + botón. Ej.: "La impresora de cocina no tiene papel. Cámbialo y toca Reimprimir." El código técnico va colapsado para soporte.
4. **Números de dinero con cifras tabulares** (font-variant-numeric: tabular-nums) y alineados a la derecha SIEMPRE. Un cierre de caja se lee en columna.
5. **Estado de conexión siempre visible** en POS/KDS: online / offline / sincronizando (n pendientes). Color + ícono, nunca solo color.
6. **Accesibilidad AA:** contraste ≥ 4.5:1, targets táctiles ≥ 48 px (POS) y ≥ 64 px (KDS), sin información solo por color.
7. **Idioma:** español peruano neutro ("boleta", "vuelto", "para llevar", "yape"). Sin anglicismos en UI de operación; los términos técnicos quedan para el panel de configuración.

## Tokens (packages/ui, consumidos por las 3 apps web)
- Tipografía: Inter (UI) — números tabulares activados; escala 12/14/16/20/24/32/48.
- Espaciado: base 4 px; densidad "operación" (POS/KDS, generosa) y "gestión" (panel, compacta).
- Color: neutros + semánticos (éxito/alerta/error/info) + **color por canal** (propio=verde marca, Rappi=naranja, PedidosYa=rojo, WhatsApp=verde WA, POS=azul) usados consistentemente en tarjetas, filtros y reportes — el operador aprende a leer el origen de un vistazo.
- Tema: claro (panel/tienda), **oscuro de alto contraste para KDS** (cocinas con luz dura y reflejos; blanco puro sobre negro cansa: usar gris 90% sobre gris 10%).
- Radios/sombras discretos: es una herramienta de trabajo, no una landing.

## Componentes compartidos obligatorios
Botón de acción principal (una por pantalla) · teclado numérico táctil (monto/PIN/cantidad) · tarjeta de pedido (mismo layout en POS, KDS, panel: nº corto, canal, marca, tiempo, estado) · badge de estado con semáforo de tiempo · lista con esqueleto de carga · modal de confirmación destructiva (escribir motivo, no solo "¿seguro?") · toast con deshacer (8 s) donde sea reversible.

## Detalles que compran al operador (baratos, de alto impacto)
- **Número corto de pedido** por local y día (#47), grande; el ULID jamás se muestra.
- **Sonidos distintos** por canal en KDS/POS (nuevo pedido propio ≠ marketplace ≠ cancelación), volumen configurable, y flash visual para ambientes ruidosos.
- **Notas de cocina imposibles de ignorar:** fondo amarillo, ícono, tamaño +1. Alérgenos declarados: banda roja.
- **"Cliente frecuente" y "primera compra"** como badge en el pedido (dato de CRM, F5): el operador puede tratar distinto sin buscar nada.
- **Modo pico:** un toque simplifica el POS a lo esencial (venta rápida, sin módulos laterales) y agranda la cola del KDS.
- **Semáforo de tiempo en cada tarjeta:** verde <70% del prometido, ámbar 70–100%, rojo vencido con minutos en contra parpadeando.
- **Reimprimir cualquier cosa en 2 toques** (comanda, precuenta, comprobante) desde la tarjeta del pedido.
- **Deshacer** en catálogos y precios (toast 8 s) — los dedos gordos en tablets existen.
