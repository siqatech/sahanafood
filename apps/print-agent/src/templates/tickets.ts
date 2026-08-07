import { EscPosBuilder } from '../escpos/builder.js';

/**
 * Plantillas de los dos documentos que el local imprime en cada pedido.
 *
 * No son lo mismo y no deben parecerse:
 *
 * · **Comanda de cocina**: la lee alguien de pie, a un metro, con prisa y a
 *   veces con las manos ocupadas. Todo grande, sin importes —el cocinero no
 *   necesita saber cuánto cuesta— y con los modificadores destacados, porque
 *   «sin cebolla» es lo que de verdad se pasa por alto.
 * · **Precuenta**: la lee el cliente sentado. Importes alineados a la derecha,
 *   desglose de IGV visible y aviso explícito de que NO es comprobante
 *   tributario — imprimir algo que parezca una boleta sin serlo es un problema
 *   con SUNAT, no un detalle de diseño.
 */

export interface KitchenTicketData {
  orderNumber: number;
  brandName: string;
  stationName: string;
  channel: string;
  /** Hora prometida al cliente, ya formateada en la zona del local. */
  promisedAt?: string | undefined;
  customerName?: string | undefined;
  lines: Array<{
    quantity: number;
    productName: string;
    modifiersText?: string | undefined;
    notes?: string | undefined;
  }>;
  notes?: string | undefined;
  printedAt: string;
}

export interface PrecheckData {
  orderNumber: number;
  brandName: string;
  locationName: string;
  /** Importes ya formateados por quien llama: el agente no calcula dinero. */
  lines: Array<{ quantity: number; productName: string; lineTotal: string }>;
  subtotal: string;
  discount?: string | undefined;
  deliveryFee?: string | undefined;
  tip?: string | undefined;
  total: string;
  taxLabel: string;
  tax: string;
  printedAt: string;
}

export interface TicketOptions {
  width?: number | undefined;
}

/**
 * Comanda de cocina.
 *
 * El número de pedido va a tamaño doble y arriba del todo: es lo que el
 * cocinero canta y lo único que necesita ver desde lejos.
 */
export function buildKitchenTicket(
  data: KitchenTicketData,
  options: TicketOptions = {},
): Buffer {
  const t = new EscPosBuilder({ width: options.width ?? 48 });

  t.init().align('center');

  t.size(2, 2).bold(true).line(`#${data.orderNumber}`).bold(false).size(1, 1);

  t.line(data.brandName);
  t.line(`${data.stationName} · ${data.channel.toUpperCase()}`);
  if (data.promisedAt) t.line(`Para: ${data.promisedAt}`);
  if (data.customerName) t.line(data.customerName);

  t.align('left').separator('=');

  for (const linea of data.lines) {
    // Cantidad y producto a doble alto: es lo que se lee de un vistazo.
    t.size(1, 2)
      .bold(true)
      .line(`${linea.quantity} x ${linea.productName}`)
      .bold(false)
      .size(1, 1);

    // Los modificadores van sangrados y en negrita: «sin cebolla» es
    // exactamente lo que se pasa por alto cuando la línea es uniforme.
    if (linea.modifiersText) {
      t.bold(true).wrapped(`> ${linea.modifiersText}`, '   ').bold(false);
    }
    if (linea.notes) t.wrapped(`* ${linea.notes}`, '   ');
    t.line();
  }

  if (data.notes) {
    t.separator('-').bold(true).line('NOTA DEL PEDIDO').bold(false);
    // «tocar el timbre dos veces, es la puerta verde» no cabe en una línea, y
    // dejar que la impresora la parta la corta a mitad de palabra.
    t.wrapped(data.notes);
  }

  t.separator('=').align('center').line(data.printedAt).cut();
  return t.build();
}

/**
 * Precuenta. NO es comprobante tributario y lo dice, en grande.
 *
 * Un papel con importes, IGV desglosado y el nombre del negocio se parece
 * bastante a una boleta; que un cliente se vaya creyendo que la tiene es un
 * problema con SUNAT, no un malentendido.
 */
export function buildPrecheck(
  data: PrecheckData,
  options: TicketOptions = {},
): Buffer {
  const t = new EscPosBuilder({ width: options.width ?? 48 });

  t.init().align('center').bold(true).size(1, 2).line(data.brandName);
  t.size(1, 1).bold(false).line(data.locationName);
  t.line(`Pedido #${data.orderNumber}`);

  t.align('left').separator('=');

  for (const linea of data.lines) {
    t.columns(`${linea.quantity} x ${linea.productName}`, linea.lineTotal);
  }

  t.separator('-');
  t.columns('Subtotal', data.subtotal);
  if (data.discount) t.columns('Descuento', data.discount);
  if (data.deliveryFee) t.columns('Delivery', data.deliveryFee);
  if (data.tip) t.columns('Propina', data.tip);

  t.bold(true).size(1, 2).columns('TOTAL', data.total).size(1, 1).bold(false);
  // El IGV va después del total y en pequeño: está INCLUIDO en el precio
  // (RN-T05), no se suma. Ponerlo antes invita a leerlo como un cargo aparte.
  t.columns(data.taxLabel, data.tax);

  t.separator('=').align('center');
  t.bold(true).line('*** NO ES COMPROBANTE DE PAGO ***').bold(false);
  t.line('Solicite su boleta o factura');
  t.line(data.printedAt);
  t.cut();

  return t.build();
}
