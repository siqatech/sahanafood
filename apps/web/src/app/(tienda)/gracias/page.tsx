import Link from 'next/link';

/**
 * Confirmación.
 *
 * Enseña el id del pedido y nada más. Ni el total, ni la dirección, ni el
 * teléfono: esta URL se comparte, se queda en el historial del navegador y
 * acaba en capturas de pantalla. Lo que hace falta para preguntar por un pedido
 * es su número; el resto solo puede filtrarse.
 */
export default async function ThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ pedido?: string }>;
}) {
  const { pedido } = await searchParams;

  return (
    <>
      <h1>¡Pedido recibido!</h1>
      <p>
        Estamos preparando tu pedido. Te avisaremos por WhatsApp cuando salga
        para tu dirección.
      </p>
      {pedido ? (
        <p className="nota">
          Número de pedido: <strong>{pedido}</strong>
        </p>
      ) : null}
      <Link href="/">
        <button type="button">Volver a la carta</button>
      </Link>
    </>
  );
}
