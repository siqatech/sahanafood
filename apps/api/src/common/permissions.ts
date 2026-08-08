/**
 * Catálogo de permisos (RN-IDN-01, docs/03, docs/14).
 *
 * Un permiso es `modulo.accion`. Este catálogo es la FUENTE DE VERDAD: los
 * guards validan contra él, los roles del sistema se siembran a partir de él y
 * `RequirePermission` está tipado con él.
 *
 * **Vive en `common/` y no en el módulo Identity**, y el motivo es el mismo por
 * el que el decorador está aquí: todos los módulos necesitan NOMBRAR permisos,
 * pero solo Identity sabe verificarlos. Estuvo dentro de Identity, y la
 * consecuencia fue concreta: `RequirePermission` tenía que aceptar `string`
 * para no crear un ciclo `common → identity → common`, y con `string` se
 * colaron dos permisos que no existían —`catalog.manage` y `delivery.manage`—.
 * Compilaban, pasaban las pruebas y dejaban esos endpoints accesibles SOLO para
 * quien tiene el comodín. Fallan cerrado, así que nadie se entera hasta que un
 * supervisor dice «no me deja» y el permiso que le falta no está en ningún
 * sitio. Moviendo el catálogo aquí, el tipo funciona y el grafo sigue acíclico.
 *
 * Los ROLES del sistema siguen en Identity: son una política de negocio, no un
 * contrato transversal.
 */

export const PERMISSIONS = [
  // Tenancy y configuración
  'tenant.read',
  'tenant.update',
  'tenant.billing',
  // Identidad
  'users.read',
  'users.write',
  'roles.read',
  'roles.write',
  // Auditoría
  'audit.read',
  // Catálogo (F4)
  'catalog.read',
  'catalog.write',
  // Pedidos (F4)
  'orders.read',
  'orders.create',
  'orders.transition',
  'orders.cancel',
  // Cancelar un pedido YA en preparación: hay costo de insumos (RN-ORD-06).
  'orders.cancel_in_progress',
  'orders.modify',
  // Vaciar la bandeja de excepciones cambia el importe que se cobrará: no es
  // una lectura, es una decisión de negocio (RN-ORD-10).
  'orders.review_exceptions',
  'orders.discount',
  // Caja (F4)
  'cash.open',
  'cash.close',
  'cash.read',
  // Cocina (F4)
  'kitchen.read',
  'kitchen.transition',
  // Fijar los umbrales de capacidad (RN-KIT-04). NO es operación: quien los
  // toca decide cuántas ventas se dejan de aceptar en hora punta, así que va
  // con el dueño y no con el encargado de turno.
  'kitchen.manage_capacity',
  // Entregas (F4-5)
  'delivery.read',
  'delivery.assign',
  // Dar de alta repartidores y tocar sus zonas y turnos. Separado de asignar:
  // el encargado de turno asigna, pero no contrata.
  'delivery.manage_couriers',
  // Marcar recogido, entregado o fallido. Es el permiso de la APP DEL
  // REPARTIDOR, y es lo ÚNICO que necesita: un repartidor no ve la caja, ni el
  // catálogo, ni los pedidos de los demás.
  'delivery.operate',
  // Liquidar el efectivo de un repartidor contra una sesión de caja
  // (RN-DLV-02). Es una operación de CAJA aunque viva en el módulo de reparto:
  // mueve dinero al cajón, así que lo autoriza quien responde de la caja.
  'delivery.settle',
  // Inventario (F4/F6)
  'inventory.read',
  'inventory.adjust',
  // Facturación electrónica (F4)
  'billing.read',
  // Emitir y reenviar un comprobante: lo hace el cajero al cobrar.
  'billing.issue',
  // Anular con nota de crédito NO es emitir. Un comprobante ya declarado se
  // revierte, y quien lo revierte responde ante SUNAT: se separa a propósito.
  'billing.void',
  // Mensajería WhatsApp (F4 avisos, F5 bot)
  'messaging.read',
  // Registrar consentimiento y bajas toca datos personales (RN-T10): se
  // separa de la lectura a propósito.
  'messaging.manage',
  // Bandeja omnicanal (F5)
  'conversations.read',
  // Responder a un cliente. Separado de leer: en un call center la mayoría
  // solo mira, y quien escribe habla EN NOMBRE de la marca.
  'conversations.reply',
  // Repartir el trabajo entre agentes. Es de supervisión, no de atención.
  'conversations.assign',
  // Reportes
  'reports.read',
  'reports.export',
  // Pagos online (F5)
  'payments.read',
  // Crear una intención de cobro es pedirle dinero a alguien: se separa de la
  // lectura. NO existe un permiso para «confirmar un pago»: eso solo lo hace el
  // webhook verificado de la pasarela (RN-PAY-01), nunca una persona.
  'payments.charge',
  // Devolver dinero es la operación más delicada del módulo: sobre el umbral
  // exige doble aprobación (RN-PAY-03).
  'payments.refund',
  // Configurar la pasarela toca credenciales y decide a qué cuenta llega el
  // dinero del tenant: queda en propietario/administrador.
  'payments.manage',
  // Tienda web (F5)
  'storefront.read',
  // Registrar y verificar el dominio de una marca. Toca a QUÉ host se sirve el
  // catálogo de quién: es la decisión más delicada de la tienda, y por eso no
  // va con `catalog.write`.
  'storefront.manage_domains',
  // Integraciones (F4 con simulador, F7 conectores reales)
  'integrations.read',
  // Crear o pausar una conexión toca credenciales y el flujo de pedidos de un
  // canal entero: se separa de la lectura a propósito.
  'integrations.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
