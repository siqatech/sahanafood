import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioAlta,
  SelectorDeRol,
  BotonEstado,
  FormularioPin,
  BotonCodigo,
  BotonRevocar,
} from './formularios';

/**
 * El equipo (specs/ux/03 → Configuración/usuarios).
 *
 * Faltaba, y su ausencia no se veía desde la API: los nueve roles se crean en
 * cada tenant y el guardia los comprueba en cada petición, pero **no había
 * forma de crear un segundo usuario**. El único era el propietario que nace con
 * el negocio.
 *
 * Lo que pasa en un local sin esta pantalla es concreto: el dueño le da SU
 * contraseña al cajero. Es la cuenta que aprueba descuadres, cambia precios y
 * firma en `audit_log`. La trazabilidad se vuelve ficción el primer día — todo
 * lo hizo el dueño, incluso lo que hizo el cocinero a las once de la noche.
 */

export default async function EquipoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const [usuarios, roles, dispositivos] = await Promise.all([
    cargar('/panel/equipo', yaSeIntento, () => panel.usuarios()),
    cargar('/panel/equipo', yaSeIntento, () => panel.rolesAsignables()),
    cargar('/panel/equipo', yaSeIntento, () => panel.dispositivos()),
  ]);

  return (
    <>
      <h1>Equipo</h1>
      <p className="panel__subtitulo">
        Cada persona con su cuenta y su rol. Compartir una cuenta hace que la
        auditoría deje de servir: todo lo firma la misma persona.
      </p>

      <div className="tabla-envoltorio">
        <table>
          <thead>
            <tr>
              <th>Persona</th>
              <th>Rol</th>
              <th>PIN</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.fullName}</strong>
                  <br />
                  <span className="tarjeta__pie">{u.email}</span>
                </td>
                <td>
                  {u.isOwner ? (
                    // Al propietario no se le cambia el rol: es la única
                    // cuenta sin escalón por encima al que pedir ayuda.
                    <span className="etiqueta">Propietario</span>
                  ) : (
                    <SelectorDeRol
                      userId={u.id}
                      actual={u.roles[0]?.code ?? ''}
                      roles={roles}
                    />
                  )}
                </td>
                <td>
                  {/* El PIN es lo que le deja entrar al POS. Sin él la persona
                      tiene cuenta y no puede abrir caja, que es una forma
                      silenciosa de no estar dado de alta. */}
                  {u.hasPin ? null : (
                    <>
                      <span className="tarjeta__pie">
                        sin PIN: no puede entrar al POS
                      </span>
                      <br />
                    </>
                  )}
                  <FormularioPin userId={u.id} />
                </td>
                <td>
                  {u.status === 'active' ? (
                    'Activa'
                  ) : (
                    <strong className="baja">Desactivada</strong>
                  )}
                </td>
                <td>
                  {u.isOwner ? null : (
                    <BotonEstado userId={u.id} activo={u.status === 'active'} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="tarjeta__pie">
        Desactivar no borra: el nombre de esa persona está en cada pedido que
        tomó y en cada arqueo que cerró.
      </p>

      <h2>Dar de alta</h2>
      <FormularioAlta roles={roles} />

      <h2>Dispositivos</h2>
      <p className="panel__subtitulo">
        Las tablets del POS y del KDS. Una tablet se empareja con un código de{' '}
        <strong>un solo uso</strong> que caduca: ese código es la credencial con
        la que un aparato sin cuenta entra, así que se enseña una vez y no se
        guarda en ninguna pantalla.
      </p>

      <BotonCodigo />

      {dispositivos.length === 0 ? (
        <p className="panel__vacio">
          Todavía no hay ninguna tablet emparejada. Emite un código y escríbelo
          en la pantalla de emparejamiento del POS.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Tablet</th>
                <th>Estado</th>
                <th>Vista por última vez</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {dispositivos.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>
                    {d.status === 'active' ? (
                      'Activa'
                    ) : (
                      <strong className="baja">Revocada</strong>
                    )}
                  </td>
                  <td>
                    {/* «Vista por última vez» y no «emparejada»: lo que se
                        pregunta cuando falta una tablet es cuándo dejó de
                        aparecer, no cuándo se dio de alta. */}
                    {d.lastSeenAt
                      ? new Date(d.lastSeenAt).toLocaleString('es-PE', {
                          timeZone: 'America/Lima',
                        })
                      : 'nunca'}
                  </td>
                  <td>
                    {d.status === 'active' ? (
                      <BotonRevocar deviceId={d.id} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
