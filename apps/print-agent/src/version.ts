/**
 * Versión del agente.
 *
 * Se declara aquí y no se lee de `package.json` a propósito: el agente se
 * distribuye compilado y `package.json` no siempre acompaña al `dist/`.
 * Leerlo en tiempo de ejecución convertiría un fichero ausente en un fallo de
 * arranque, y el soporte necesita esta versión precisamente cuando algo va mal.
 *
 * Debe coincidir con la de `package.json`; hay una prueba que lo verifica.
 */
export const VERSION = '0.1.0';
