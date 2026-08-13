import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { tokenDeAcceso } from '../../lib/panel-session';
import { Navegacion } from './navegacion';
import './panel.css';

/**
 * Marco del panel de gestión (specs/ux/03).
 *
 * ### Por qué el panel puede NO servirse aquí
 *
 * `apps/web` sirve la tienda de cada cliente en **su propio dominio**. Sin esta
 * comprobación, `polleria.pe/panel` enseñaría la pantalla de acceso de la
 * plataforma dentro de la tienda de un cliente: no hay fuga de datos —el tenant
 * sale del token— pero sí una puerta de administración colgando de un dominio
 * comercial ajeno, y un formulario de acceso donde nadie lo espera es donde se
 * pescan contraseñas.
 *
 * Con `SAHANA_PANEL_HOST` puesto, el panel **solo existe en ese host** y en los
 * demás responde 404, igual que cualquier ruta que no existe. Sin la variable
 * —desarrollo, pruebas— sirve en cualquiera: exigirla ahí solo haría que nadie
 * pudiera probar el panel en `localhost`.
 */

export const metadata: Metadata = {
  title: 'Panel · Sahana Food',
  // El panel no se indexa: es una herramienta de trabajo, y una pantalla de
  // acceso en un buscador solo atrae intentos.
  robots: { index: false, follow: false },
};

export default async function PanelLayout({
  children,
}: {
  children: ReactNode;
}) {
  const permitido = process.env['SAHANA_PANEL_HOST']?.trim().toLowerCase();
  if (permitido) {
    const h = await headers();
    const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '')
      .toLowerCase()
      // El puerto no cuenta: en un proxy el host llega sin él y en local con él.
      .split(':')[0];
    if (host !== permitido.split(':')[0]) notFound();
  }

  // Sin sesión no se pinta la navegación. No es estética: enseñar «Carta» y
  // «Negocio» a quien todavía no ha entrado son tres enlaces que llevan a la
  // misma pantalla de acceso, y eso hace dudar de si la contraseña falló.
  const conSesion = (await tokenDeAcceso()) !== undefined;

  // Sin sesión, el marco es una sola columna: la pantalla de acceso no necesita
  // —ni debe tener— una barra lateral que no lleva a ningún sitio.
  if (!conSesion) {
    return (
      <div className="panel panel--suelto">
        <header className="panel__cabecera">
          <Link href="/panel" className="panel__marca">
            Sahana&nbsp;Food
          </Link>
        </header>
        <main className="panel__cuerpo">{children}</main>
      </div>
    );
  }

  return (
    <div className="panel panel--con-barra">
      {/* La barra lateral, y no una fila de enlaces arriba: con veintidós
          pantallas la fila se sale de cualquier portátil y no agrupa nada.
          En móvil la barra se convierte en una tira que se desplaza, porque
          «consultar es mobile-first» (specs/ux/03) y ahí el ancho es del
          contenido. */}
      <aside className="panel__barra">
        <Link href="/panel" className="panel__marca">
          Sahana&nbsp;Food
        </Link>
        <Navegacion />
        {/* Formulario y no enlace: cerrar sesión cambia estado en el
            servidor, y un GET lo dejaría a merced de cualquier imagen
            remota que apuntara a esta URL. */}
        <form action="/panel/salir" method="post" className="panel__pie-barra">
          <button type="submit" className="panel__salir">
            Salir
          </button>
        </form>
      </aside>
      <main className="panel__cuerpo">{children}</main>
    </div>
  );
}
