# Reglas de negocio transversales

Las reglas por módulo viven en su spec. Estas aplican a todo el sistema.

- **RN-T01** Ningún dato de un tenant es visible ni relacionable con otro tenant. Sin excepciones de aplicación; solo el rol de soporte con auditoría.
- **RN-T02** El pedido confirmado es inmutable en sus datos comerciales (snapshot de precio, nombre, impuesto, comisión pactada). Las modificaciones crean líneas de ajuste, nunca reescriben.
- **RN-T03** Nada se borra físicamente si destruye trazabilidad: estados + historial + política de retención.
- **RN-T04** Todo monto se calcula en `@sahana/domain`. El redondeo es half-up a 2 decimales al TOTAL, los subtotales conservan 4.
- **RN-T05** IGV Perú 18% incluido en precio de venta al público; el desglose se calcula hacia atrás. Configurable por país (F9).
- **RN-T06** Un producto sin receta puede venderse (MVP), pero genera alerta de "costo desconocido" en analítica.
- **RN-T07** La venta offline nunca se rechaza en sincronización: se acepta y las inconsistencias (stock negativo, precio cambiado) generan alertas, no bloqueos. El precio del snapshot offline prevalece para ese pedido.
- **RN-T08** Descuentos sobre umbral configurable (por defecto 15%) requieren PIN de supervisor y quedan en auditoría.
- **RN-T09** Comisión estimada ≠ comisión liquidada. Se registran ambas y se reporta la diferencia por canal.
- **RN-T10** Consentimiento de marketing: registro con timestamp, origen y texto exacto aceptado (Ley 29733 + política Meta).
