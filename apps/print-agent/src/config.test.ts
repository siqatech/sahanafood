import { describe, it, expect } from 'vitest';
import { parsePrinters, loadConfig } from './config.js';
import { VERSION } from './version.js';
import { readFileSync } from 'node:fs';

const ENTORNO_MINIMO = {
  AGENT_TOKEN: 'token-de-emparejamiento-largo',
  PRINTERS: 'cocina=file:/tmp/cocina.bin',
} as NodeJS.ProcessEnv;

describe('Configuración por entorno', () => {
  it('lee impresoras de red y de fichero', () => {
    const p = parsePrinters(
      'cocina=net:192.168.1.50:9100,caja=file:/dev/usb/lp0',
    );
    expect(p.map((x) => x.name)).toEqual(['cocina', 'caja']);
    expect(p[0]!.target).toBe('net:192.168.1.50:9100');
    expect(p[1]!.target).toBe('file:/dev/usb/lp0');
  });

  it('el puerto de red por defecto es 9100', () => {
    // Es el que usan prácticamente todas las térmicas; obligar a escribirlo
    // sería una fuente de erratas en la instalación.
    expect(parsePrinters('cocina=net:192.168.1.50')).toHaveLength(1);
  });

  it('rechaza dos impresoras con el mismo nombre', () => {
    // La segunda pisaría a la primera en silencio y las comandas de una
    // estación acabarían saliendo por la otra.
    expect(() =>
      parsePrinters('cocina=net:192.168.1.50,cocina=file:/dev/usb/lp0'),
    ).toThrow(/dos veces/);
  });

  it('rechaza configuraciones que no se entienden, diciendo el formato', () => {
    for (const malo of [
      'cocina',
      'cocina=',
      '=net:1.2.3.4',
      'cocina=usb:0',
      'cocina=net:',
      'cocina=file:',
    ]) {
      expect(() => parsePrinters(malo)).toThrow();
    }
    expect(() => parsePrinters('cocina=usb:0')).toThrow(/net: o file:/);
  });

  it('rechaza un puerto imposible en vez de intentar conectarse a él', () => {
    expect(() => parsePrinters('cocina=net:192.168.1.50:99999')).toThrow(
      /Puerto inválido/,
    );
  });

  it('sin impresoras no arranca: un agente sin impresoras no sirve de nada', () => {
    expect(() => parsePrinters('   ')).toThrow(/No hay ninguna impresora/);
  });

  it('exige AGENT_TOKEN y que sea suficientemente largo', () => {
    // Sin token, cualquier pestaña abierta en el mismo navegador podría
    // imprimir en la cocina.
    expect(() => loadConfig({ ...ENTORNO_MINIMO, AGENT_TOKEN: '' })).toThrow(
      /AGENT_TOKEN/,
    );
    expect(() =>
      loadConfig({ ...ENTORNO_MINIMO, AGENT_TOKEN: 'corto' }),
    ).toThrow(/16 caracteres/);
  });

  it('rechaza un ancho de ticket fuera de rango, explicando los dos habituales', () => {
    // Un ancho mal puesto parte TODAS las líneas y no se nota hasta la primera
    // comanda, con el local ya abierto.
    const error = () => loadConfig({ ...ENTORNO_MINIMO, TICKET_WIDTH: '480' });
    expect(error).toThrow(/58 mm/);
    expect(error).toThrow(/80 mm/);
  });

  it('aplica los valores por defecto del hardware recomendado', () => {
    const c = loadConfig(ENTORNO_MINIMO);
    expect(c.port).toBe(7443);
    expect(c.ticketWidth).toBe(48); // papel de 80 mm
    expect(c.queueFile).toMatch(/\.sahana[/\\]print-queue\.json$/);
  });

  it('la versión declarada coincide con la de package.json', () => {
    // El soporte pide esta versión justo cuando algo va mal; que mienta es
    // peor que no tenerla.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
