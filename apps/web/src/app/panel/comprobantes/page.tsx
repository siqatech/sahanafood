import Link from 'next/link';
import { panel, type DocumentoDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioCorreccion,
  BotonReenviar,
  FormularioAnulacion,
} from './formularios';

/**
 * Comprobantes: la cola de corrección (RN-BIL-02, spec 10).
 *
 * La regla dice «documento rechazado por OSE → **cola de corrección**; NUNCA se
 * pierde la venta». La cola existía desde F4 —el documento se quedaba en
 * `rejected` con el motivo del OSE al lado— y no se podía vaciar: la única
 * acción expuesta era reenviar, que manda otra vez el mismo RUC que el OSE
 * acaba de rechazar, y crear otro comprobante para la misma venta está
 * prohibido a propósito. La venta no se perdía; simplemente **no se podía
 * facturar nunca**, que ante SUNAT viene a ser lo mismo.
 */

const ROTULO_TIPO: Record<string, string> = {
  boleta: 'Boleta',
  factura: 'Factura',
  nota_credito: 'Nota de crédito',
};

const ROTULO_ESTADO: Record<string, string> = {
  queued: 'En cola',
  numbered: 'Numerado, sin enviar',
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  voided: 'Anulado',
};

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Cliente({ doc }: { doc: DocumentoDelPanel }) {
  if (doc.customerDocType === 'NONE') {
    return <span className="tarjeta__pie">Sin identificar</span>;
  }
  return (
    <span className="tarjeta__pie">
      {doc.customerDocType} {doc.customerDocNumber ?? ''}
      {doc.customerName ? ` · ${doc.customerName}` : ''}
    </span>
  );
}

export default async function ComprobantesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const [rechazados, pendientes, emitidos] = await Promise.all([
    cargar('/panel/comprobantes', yaSeIntento, () =>
      panel.documentos('rejected'),
    ),
    cargar('/panel/comprobantes', yaSeIntento, () =>
      panel.documentos('queued'),
    ),
    cargar('/panel/comprobantes', yaSeIntento, () =>
      panel.documentos('accepted'),
    ),
  ]);

  // Los numerados-sin-enviar cuentan como pendientes: para quien mira la
  // pantalla son lo mismo —una venta sin declarar— y separarlos por un detalle
  // interno de la numeración solo esconde la mitad del problema.
  const sinEnviar = await panel.documentos('numbered').catch(() => []);
  const enCola = [...pendientes, ...sinEnviar];

  return (
    <>
      <h1>Comprobantes</h1>
      <p className="panel__subtitulo">
        Lo que SUNAT ya tiene y lo que todavía no. Un comprobante emitido nunca
        se edita ni se borra: se corrige antes de que lo acepten, o se revierte
        con una nota de crédito después.
      </p>

      <h2>
        Rechazados{' '}
        {rechazados.length > 0 ? (
          <span className="etiqueta etiqueta--pausado">
            {rechazados.length}
          </span>
        ) : null}
      </h2>

      {rechazados.length === 0 ? (
        <p className="panel__vacio">
          Nada rechazado. La venta se declara sola al cobrar.
        </p>
      ) : (
        rechazados.map((d) => (
          <article key={d.id} className="ficha ficha--revision">
            <p>
              <strong>
                {ROTULO_TIPO[d.docType] ?? d.docType}{' '}
                {d.number ?? '(sin número)'}
              </strong>{' '}
              · S/ {d.total} · {momento(d.issuedAt)}
            </p>
            <p>
              <Cliente doc={d} />
            </p>
            <p className="panel__error">
              {d.rejectionCode ? `${d.rejectionCode}: ` : ''}
              {d.rejectionReason ?? 'sin motivo devuelto'}
            </p>
            {/* El número se conserva. Un rechazado nunca fue válido, así que
                reenviarlo corregido con su mismo correlativo es lo correcto;
                darle uno nuevo dejaría un hueco en la serie que hay que
                justificar ante SUNAT con una comunicación de baja. */}
            <p className="tarjeta__pie">
              Se reenvía con el mismo número: {d.attempts}{' '}
              {d.attempts === 1 ? 'intento' : 'intentos'} hasta ahora.
              {d.orderId ? (
                <>
                  {' · '}
                  <Link href={`/panel/pedidos/${d.orderId}`}>Ver la venta</Link>
                </>
              ) : null}
            </p>
            <FormularioCorreccion
              id={d.id}
              docType={d.customerDocType}
              docNumber={d.customerDocNumber}
              legalName={d.customerName}
            />
            <BotonReenviar id={d.id} />
          </article>
        ))
      )}

      <h2>En cola</h2>
      <p className="tarjeta__pie">
        El plazo de SUNAT corre contra la fecha de la <strong>venta</strong>, no
        contra la del envío (RN-BIL-03). Una venta de ayer que sigue aquí tiene
        menos margen del que parece.
      </p>
      {enCola.length === 0 ? (
        <p className="panel__vacio">Nada pendiente de enviar.</p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Comprobante</th>
                <th>Cliente</th>
                <th className="dinero">Total</th>
                <th>Venta</th>
                <th>Plazo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {enCola.map((d) => (
                <tr key={d.id}>
                  <td>
                    {ROTULO_TIPO[d.docType] ?? d.docType}
                    <br />
                    <span className="tarjeta__pie">
                      {d.number ?? ROTULO_ESTADO[d.status]}
                    </span>
                  </td>
                  <td>
                    <Cliente doc={d} />
                  </td>
                  <td className="dinero">S/ {d.total}</td>
                  <td>{momento(d.issuedAt)}</td>
                  <td>
                    {d.deferral ? (
                      d.deferral.status === 'ok' ? (
                        `${Math.round(d.deferral.hoursRemaining)} h`
                      ) : (
                        <strong className="baja">
                          {d.deferral.status === 'expired'
                            ? 'Vencido'
                            : `Quedan ${Math.round(d.deferral.hoursRemaining)} h`}
                        </strong>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <BotonReenviar id={d.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Aceptados</h2>
      {emitidos.length === 0 ? (
        <p className="panel__vacio">Todavía no hay comprobantes aceptados.</p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Comprobante</th>
                <th>Cliente</th>
                <th className="dinero">Total</th>
                <th>Emitido</th>
                <th>Anular</th>
              </tr>
            </thead>
            <tbody>
              {emitidos.slice(0, 50).map((d) => (
                <tr key={d.id}>
                  <td>
                    {ROTULO_TIPO[d.docType] ?? d.docType}
                    <br />
                    <span className="tarjeta__pie">{d.number}</span>
                  </td>
                  <td>
                    <Cliente doc={d} />
                  </td>
                  <td className="dinero">S/ {d.total}</td>
                  <td>{momento(d.issuedAt)}</td>
                  <td>
                    {/* Anular exige `billing.void`, que el cajero no tiene: un
                        comprobante ya declarado lo revierte quien responde de
                        él ante SUNAT. Si falta el permiso, la API lo dice. */}
                    <FormularioAnulacion id={d.id} />
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
