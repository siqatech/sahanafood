import { FormularioDeAcceso } from './formulario';

/**
 * Acceso al panel.
 *
 * `?destino=` conserva a dónde iba el operador antes de que caducara la sesión.
 * Se valida en la acción, no aquí: quien decide es quien redirige.
 */
export default async function EntrarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const destino =
    typeof params['destino'] === 'string' ? params['destino'] : '/panel';
  return (
    <FormularioDeAcceso
      destino={destino}
      caducada={params['caducada'] !== undefined}
    />
  );
}
