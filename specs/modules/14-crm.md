# Módulo: CRM
> Fase: 5 (perfil) / 8 (campañas)

Perfil unificado por teléfono/email cross-canal (merge asistido, nunca automático destructivo) · historial · cupones (código, %/fijo, vigencia, límite de usos, por marca/canal) · segmentación (frecuencia, ticket, inactividad) · campañas WhatsApp/email respetando consentimiento y presupuesto de mensajes · reclamos con estados y SLA interno.
Reglas clave: RN-CRM-01 consentimiento por canal y por marca, separados. RN-CRM-02 anonimización a solicitud sin romper pedidos (se desvincula PII, queda el registro comercial). RN-CRM-03 cupón se valida en @sahana/domain (mismo código en tienda y POS).
Pruebas: merge de duplicados · cupón expirado/límite · anonimización end-to-end · aislamiento.
