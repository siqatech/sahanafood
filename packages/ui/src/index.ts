/**
 * @sahana/ui — tokens y vocabulario visual compartidos (docs/25 §Tokens).
 *
 * Deliberadamente SIN componentes: son tres superficies con tres usuarios, tres
 * distancias de lectura y tres tamaños de objetivo táctil. Lo que se comparte es
 * el vocabulario —qué es «error», qué es «Rappi», cuánto es un radio—, no el
 * marcado.
 *
 * Las hojas de estilo se importan por su ruta:
 *   `@sahana/ui/tokens.css`  · los tokens
 *   `@sahana/ui/canales.css` · el color por canal, claro y oscuro
 */

export {
  aspectoDeCanal,
  canalesConocidos,
  type AspectoDeCanal,
} from './canales.js';
