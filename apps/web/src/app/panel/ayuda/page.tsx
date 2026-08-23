import { panel } from '../../../lib/panel-api';
import { FormularioDeAyuda } from './formulario';
import type { ContextoDeSoporte } from './mensaje';

/**
 * Ayuda (docs/26 «Soporte como producto»).
 *
 * Pedir ayuda por **WhatsApp**, que es el mismo canal que le vendemos al
 * cliente: si no nos sirve a nosotros para atender, mal se lo estamos vendiendo
 * a él para atender a los suyos. Y con el contexto ya escrito, porque la
 * primera media hora de cualquier incidencia se va en «¿qué negocio eres?, ¿qué
 * local?, ¿qué versión tienes?».
 *
 * **Previa confirmación**, que es la parte que no se puede saltar: los datos
 * técnicos se enseñan tal cual van a salir y con una casilla que se puede
 * desmarcar. Un adjunto automático e invisible es una fuga con buena intención.
 */
export const metadata = { title: 'Ayuda' };

/**
 * Versión desplegada.
 *
 * Sale del entorno porque es una propiedad del DESPLIEGUE, no del código: dos
 * despliegues del mismo commit son la misma versión, y el número tiene que
 * coincidir con el que ve quien opera la plataforma. Si nadie la puso, se dice
 * que no se sabe en vez de inventar una: soporte prefiere «sin identificar» a
 * un número que no corresponde con nada.
 */
function versionDesplegada(): string {
  const v =
    process.env['SAHANA_VERSION']?.trim() ||
    process.env['RAILWAY_GIT_COMMIT_SHA']?.trim();
  if (!v) return 'sin identificar';
  // Un SHA entero no lo lee nadie por teléfono.
  return v.length > 12 ? v.slice(0, 12) : v;
}

export default async function AyudaPage() {
  // Se piden los dos a la vez: son independientes y encadenarlos duplicaría la
  // espera de una pantalla que se abre justo cuando algo va mal.
  const [perfil, estructura] = await Promise.all([
    panel.perfil(),
    panel.estructura(),
  ]);

  const negocio =
    estructura.companies[0]?.legalName ??
    estructura.brands[0]?.name ??
    'Sin nombre todavía';

  const contexto: ContextoDeSoporte = {
    negocio,
    local: estructura.locations[0]?.name ?? null,
    // Los primeros ocho caracteres bastan para encontrar al cliente y caben en
    // un mensaje que alguien va a leer en un móvil.
    tenantId: perfil.tenantId.slice(0, 8),
    version: versionDesplegada(),
    cuando: new Date().toLocaleString('es-PE', {
      timeZone: 'America/Lima',
      dateStyle: 'short',
      timeStyle: 'short',
    }),
  };

  return (
    <>
      <h1>Ayuda</h1>
      <p className="panel__subtitulo">
        Escríbenos por WhatsApp. Antes de mandar el mensaje puedes ver
        exactamente qué se adjunta.
      </p>

      <FormularioDeAyuda
        contexto={contexto}
        numeroDeSoporte={process.env['SAHANA_SUPPORT_WHATSAPP']}
      />
    </>
  );
}
