import Link from 'next/link';
import { Vacio } from '../../vacio';
import { panel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { FormularioRespuesta, BotonBorrar } from './formularios';

/**
 * Respuestas rápidas del equipo (spec 18 §4).
 *
 * La tabla `cnv_quick_replies` existe desde T5.19 y la bandeja ya sabía
 * leerla. Lo que no existía era **escribir**: no había endpoint de creación ni
 * pantalla, así que la única forma de tener una respuesta rápida era un
 * `INSERT` a mano contra la base. En la práctica: cero.
 *
 * La consecuencia no es estética. En una bandeja de WhatsApp la dirección de
 * recojo, el horario y la política de cambios se escriben cuarenta veces al
 * día, y reescribirlas es exactamente cómo se manda el horario del local
 * equivocado a las nueve de la noche con doce conversaciones abiertas.
 */
export default async function RespuestasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const ruta = '/panel/conversaciones/respuestas';

  const [respuestas, estructura] = await Promise.all([
    cargar(ruta, yaSeIntento, () => panel.respuestasRapidas()),
    cargar(ruta, yaSeIntento, () => panel.estructura()),
  ]);

  const nombreDeMarca = new Map(estructura.brands.map((b) => [b.id, b.name]));

  return (
    <>
      <h1>Respuestas rápidas</h1>
      <p className="panel__subtitulo">
        Lo que el equipo escribe cuarenta veces al día. En la bandeja se
        insertan con un clic, o se escriben con barra —<code>/recojo</code>— y
        el texto aparece solo al enviar.
      </p>

      <h2>Las que hay</h2>
      {respuestas.length === 0 ? (
        <Vacio
          titulo="Todavía no hay ninguna"
          accion={{ href: '#nueva', rotulo: 'Escribir la primera' }}
        >
          <p>
            Empieza por la que más repites: la dirección de recojo o el horario.
          </p>
        </Vacio>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Atajo</th>
                <th>Qué se manda</th>
                <th>Marca</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {respuestas.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>/{r.shortcut}</code>
                  </td>
                  <td>{r.body}</td>
                  <td>
                    {/* «Todas» escrito, no una celda vacía: la diferencia
                        entre una plantilla general y una de marca es la que
                        decide si se manda la dirección correcta. */}
                    {r.brandId === null
                      ? 'Todas'
                      : (nombreDeMarca.get(r.brandId) ?? 'otra marca')}
                  </td>
                  <td>
                    <BotonBorrar id={r.id} atajo={`/${r.shortcut}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 id="nueva">Escribir una nueva</h2>
      <FormularioRespuesta
        marcas={estructura.brands.map((b) => ({ id: b.id, name: b.name }))}
      />

      <p style={{ marginTop: 24 }}>
        <Link href="/panel/conversaciones">← Volver a la bandeja</Link>
      </p>
    </>
  );
}
