/**
 * Configuración de Next para la tienda (T5.08, T5.14).
 *
 * El presupuesto de rendimiento de T5.14 —JS < 200 KB en el catálogo— no se
 * cumple con una optimización al final: se cumple no metiendo JavaScript. Por
 * eso la tienda es de componentes de servidor salvo donde hace falta reaccionar
 * a un clic, y por eso aquí no hay ninguna librería de UI, ni de estado, ni de
 * fetching. Cada una de esas cabe de sobra en el presupuesto ella sola.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // El id de compilación no lleva marca de tiempo: dos compilaciones del mismo
  // commit tienen que dar el mismo resultado para que la comprobación de
  // presupuesto compare peras con peras.
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // La tienda se sirve en el dominio del cliente y no debe poder
          // enmarcarse: un iframe en un sitio ajeno sobre el checkout es la
          // forma clásica de robar clics de pago.
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
