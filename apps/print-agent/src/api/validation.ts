/**
 * Validación de las peticiones del agente.
 *
 * Está escrita a mano, sin `zod`, y es una decisión deliberada: **el agente no
 * tiene ninguna dependencia de ejecución.**
 *
 * Se instala en máquinas ajenas —una laptop vieja del local, a veces sin
 * internet— copiando una carpeta. Con una sola dependencia, esa copia deja de
 * funcionar: `node_modules` en un monorepo pnpm son enlaces al almacén, así que
 * o se empaqueta con un bundler, o el instalador baja paquetes de npm en el
 * local, o se distribuye un tarball con las dependencias aplanadas. Las tres
 * opciones añaden una pieza que puede fallar en el sitio donde menos podemos
 * ir a arreglarla.
 *
 * A cambio hay que escribir esto. Son tres formularios de campos simples
 * —cadenas y enteros—, no un esquema de dominio: el precio es bajo y se paga
 * una vez.
 *
 * Los errores se ACUMULAN en vez de lanzar al primero. Quien integra la PWA
 * quiere ver los cinco campos que le faltan de una vez, no descubrirlos en
 * cinco intentos.
 */

export class DatosInvalidosError extends Error {
  constructor(readonly issues: string[]) {
    super(`Datos de impresión inválidos: ${issues.join('; ')}`);
    this.name = 'DatosInvalidosError';
  }
}

class Validador {
  readonly issues: string[] = [];

  constructor(private readonly raiz: unknown) {}

  private valor(ruta: string): unknown {
    if (typeof this.raiz !== 'object' || this.raiz === null) return undefined;
    return (this.raiz as Record<string, unknown>)[ruta];
  }

  texto(campo: string): string {
    const v = this.valor(campo);
    if (typeof v !== 'string' || v.length === 0) {
      this.issues.push(`"${campo}" debe ser un texto no vacío`);
      return '';
    }
    return v;
  }

  textoOpcional(campo: string): string | undefined {
    const v = this.valor(campo);
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length === 0) {
      this.issues.push(`"${campo}", si viene, debe ser un texto no vacío`);
      return undefined;
    }
    return v;
  }

  /**
   * Lista de textos opcional, filtrando lo que no lo sea.
   *
   * A diferencia de los demás validadores, este **no rechaza** la petición si
   * llega un elemento raro: se queda con los textos y sigue. El motivo es el
   * caso de uso —los alérgenos— y es deliberado: una comanda que NO SE IMPRIME
   * deja a la cocina sin nada, mientras que una que imprime tres alérgenos de
   * los cuatro que venían deja al cocinero con tres advertencias más que
   * ninguna. Rechazar entera la comanda por un dato sucio sería elegir la peor
   * de las dos.
   */
  listaDeTextosOpcional(campo: string): string[] | undefined {
    const v = this.valor(campo);
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) {
      this.issues.push(`"${campo}", si viene, debe ser una lista`);
      return undefined;
    }
    const textos = v.filter(
      (x): x is string => typeof x === 'string' && x.trim().length > 0,
    );
    return textos.length > 0 ? textos : undefined;
  }

  enteroPositivo(campo: string): number {
    const v = this.valor(campo);
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      this.issues.push(`"${campo}" debe ser un entero mayor que cero`);
      return 0;
    }
    return v;
  }

  /**
   * Lista con al menos un elemento. Un ticket sin líneas es papel gastado: la
   * cocina recibe una comanda vacía y nadie sabe qué preparar.
   */
  lista<T>(campo: string, leer: (item: Validador, i: number) => T): T[] {
    const v = this.valor(campo);
    if (!Array.isArray(v) || v.length === 0) {
      this.issues.push(
        `"${campo}" debe ser una lista con al menos un elemento`,
      );
      return [];
    }
    return v.map((item, i) => {
      const sub = new Validador(item);
      const leido = leer(sub, i);
      // Se reetiquetan para que el error diga «lines[2].quantity» y no
      // «quantity»: con doce líneas, saber cuál falla lo es todo.
      this.issues.push(...sub.issues.map((m) => `${campo}[${i}].${m}`));
      return leido;
    });
  }

  fin(): void {
    if (this.issues.length > 0) throw new DatosInvalidosError(this.issues);
  }
}

export interface ComandaDto {
  jobId?: string | undefined;
  printer: string;
  orderNumber: number;
  brandName: string;
  stationName: string;
  channel: string;
  promisedAt?: string | undefined;
  customerName?: string | undefined;
  lines: Array<{
    quantity: number;
    productName: string;
    modifiersText?: string | undefined;
    notes?: string | undefined;
    allergens?: string[] | undefined;
  }>;
  notes?: string | undefined;
}

export function parseComanda(cuerpo: unknown): ComandaDto {
  const v = new Validador(cuerpo);
  const dto: ComandaDto = {
    jobId: v.textoOpcional('jobId'),
    printer: v.texto('printer'),
    orderNumber: v.enteroPositivo('orderNumber'),
    brandName: v.texto('brandName'),
    stationName: v.texto('stationName'),
    channel: v.texto('channel'),
    promisedAt: v.textoOpcional('promisedAt'),
    customerName: v.textoOpcional('customerName'),
    lines: v.lista('lines', (l) => ({
      quantity: l.enteroPositivo('quantity'),
      productName: l.texto('productName'),
      modifiersText: l.textoOpcional('modifiersText'),
      notes: l.textoOpcional('notes'),
      // Se filtra a textos: lo que llega es JSON de fuera y una comanda no
      // puede caerse por un número donde debía ir un alérgeno.
      allergens: l.listaDeTextosOpcional('allergens'),
    })),
    notes: v.textoOpcional('notes'),
  };
  v.fin();
  return dto;
}

export interface PrecuentaDto {
  jobId?: string | undefined;
  printer: string;
  orderNumber: number;
  brandName: string;
  locationName: string;
  lines: Array<{ quantity: number; productName: string; lineTotal: string }>;
  subtotal: string;
  discount?: string | undefined;
  deliveryFee?: string | undefined;
  tip?: string | undefined;
  total: string;
  taxLabel: string;
  tax: string;
}

export function parsePrecuenta(cuerpo: unknown): PrecuentaDto {
  const v = new Validador(cuerpo);
  const dto: PrecuentaDto = {
    jobId: v.textoOpcional('jobId'),
    printer: v.texto('printer'),
    orderNumber: v.enteroPositivo('orderNumber'),
    brandName: v.texto('brandName'),
    locationName: v.texto('locationName'),
    lines: v.lista('lines', (l) => ({
      quantity: l.enteroPositivo('quantity'),
      productName: l.texto('productName'),
      // Texto y no número: los importes llegan YA formateados porque el
      // cálculo vive en @sahana/domain. Aceptar un number aquí invitaría a
      // formatearlo en el agente y a que la precuenta no cuadre con la boleta.
      lineTotal: l.texto('lineTotal'),
    })),
    subtotal: v.texto('subtotal'),
    discount: v.textoOpcional('discount'),
    deliveryFee: v.textoOpcional('deliveryFee'),
    tip: v.textoOpcional('tip'),
    total: v.texto('total'),
    taxLabel: v.texto('taxLabel'),
    tax: v.texto('tax'),
  };
  v.fin();
  return dto;
}

export interface PruebaDto {
  printer: string;
  jobId?: string | undefined;
}

export function parsePrueba(cuerpo: unknown): PruebaDto {
  const v = new Validador(cuerpo);
  const dto: PruebaDto = {
    printer: v.texto('printer'),
    jobId: v.textoOpcional('jobId'),
  };
  v.fin();
  return dto;
}
