import { describe, it, expect } from 'vitest';
import { construirMensaje, enlaceDeWhatsApp } from './mensaje';
import type { ContextoDeSoporte } from './mensaje';

const contexto: ContextoDeSoporte = {
  negocio: 'Pollería El Sabor SAC',
  local: 'Miraflores',
  tenantId: '0c8f7a1e',
  version: '2026.08.23',
  cuando: '23/08/2026, 11:14',
};

describe('construirMensaje', () => {
  it('pone primero lo que escribió la persona y los datos al final', () => {
    const m = construirMensaje({
      texto: 'No me imprime la comanda en cocina.',
      contexto,
      adjuntarDatos: true,
    });

    expect(m).toContain('No me imprime la comanda en cocina.');
    // El orden importa: soporte abre el chat y tiene que leer la frase, no
    // una ficha de sistema.
    expect(m.indexOf('No me imprime')).toBeLessThan(
      m.indexOf('--- Datos técnicos ---'),
    );
    expect(m).toContain('Negocio: Pollería El Sabor SAC');
    expect(m).toContain('Local: Miraflores');
    expect(m).toContain('Versión: 2026.08.23');
  });

  it('SIN marcar la casilla no sale ni un dato técnico', () => {
    // Es la promesa de la pantalla: la casilla manda. Si se adjuntara igual,
    // la confirmación sería decorativa y la próxima persona no la leería.
    const m = construirMensaje({
      texto: 'Una duda con las promociones.',
      contexto,
      adjuntarDatos: false,
    });

    expect(m).toContain('Una duda con las promociones.');
    expect(m).not.toContain('Datos técnicos');
    expect(m).not.toContain('Pollería El Sabor SAC');
    expect(m).not.toContain('0c8f7a1e');
  });

  it('la línea del código de error solo aparece si hay código', () => {
    const sin = construirMensaje({ texto: 'x', contexto, adjuntarDatos: true });
    expect(sin).not.toContain('Código de error');

    const con = construirMensaje({
      texto: 'x',
      contexto: { ...contexto, codigoDeError: '  01M0QMMG9Y42EK5  ' },
      adjuntarDatos: true,
    });
    expect(con).toContain('Código de error: 01M0QMMG9Y42EK5');
  });

  it('un local todavía sin dar de alta no rompe el mensaje', () => {
    const m = construirMensaje({
      texto: 'Recién empiezo.',
      contexto: { ...contexto, local: null },
      adjuntarDatos: true,
    });
    expect(m).toContain('Local: —');
  });

  it('sin texto sigue habiendo mensaje: el saludo y los datos', () => {
    // Quien no sabe qué escribir manda igualmente algo con lo que soporte
    // puede empezar; obligar a redactar antes de pedir ayuda es una barrera.
    const m = construirMensaje({
      texto: '   ',
      contexto,
      adjuntarDatos: true,
    });
    expect(m).toContain('Hola, necesito ayuda');
    expect(m).toContain('Negocio: Pollería El Sabor SAC');
  });
});

describe('enlaceDeWhatsApp', () => {
  it('deja solo los dígitos del número', () => {
    const enlace = enlaceDeWhatsApp('+51 987 654 321', 'hola');
    expect(enlace).toBe('https://wa.me/51987654321?text=hola');
  });

  it('escapa el mensaje, saltos de línea incluidos', () => {
    const enlace = enlaceDeWhatsApp('51987654321', 'una cosa\ny otra & más');
    expect(enlace).toContain('una%20cosa%0Ay%20otra%20%26%20m%C3%A1s');
  });

  it('sin número configurado devuelve null, no un enlace roto', () => {
    // Un botón que abre WhatsApp sin destinatario hace creer que el mensaje
    // salió, y el operador se queda esperando respuesta a algo que nadie
    // recibió.
    expect(enlaceDeWhatsApp(undefined, 'hola')).toBeNull();
    expect(enlaceDeWhatsApp('', 'hola')).toBeNull();
    expect(enlaceDeWhatsApp('123', 'hola')).toBeNull();
  });
});
