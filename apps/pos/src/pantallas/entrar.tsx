import { useEffect, useState } from 'react';
import { api, ApiError, SinRed, type Operador } from '../lib/api';
import { almacen, type EstadoDelDispositivo } from '../lib/db';

/**
 * Entrar con PIN (ux/01, «Sesión por PIN»).
 *
 * Dos toques: el cajero se busca en la lista y teclea cuatro dígitos. Ni
 * correo ni contraseña: eso se teclea una vez al día en un escritorio, no
 * veinte veces en una tablet con grasa y con cola delante.
 *
 * El teclado es de la aplicación y no el del sistema. No es capricho: el del
 * sistema tapa media pantalla, tarda en aparecer y en una tablet con guantes es
 * inutilizable. Los objetivos táctiles van a 64 px como pide docs/25.
 */
export function Entrar({
  dispositivo,
  alEntrar,
}: {
  dispositivo: EstadoDelDispositivo;
  alEntrar: () => void;
}) {
  const [operadores, setOperadores] = useState<Operador[] | null>(null);
  const [elegido, setElegido] = useState<Operador | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  useEffect(() => {
    let vivo = true;
    api
      .operadores(dispositivo.deviceToken)
      .then((r) => {
        if (vivo) setOperadores(r.operators);
      })
      .catch((err: unknown) => {
        if (!vivo) return;
        setError(
          err instanceof SinRed
            ? 'Sin conexión: entrar necesita internet. Las ventas ya encoladas siguen a salvo.'
            : 'No se pudo cargar la lista de operadores.',
        );
        setOperadores([]);
      });
    return () => {
      vivo = false;
    };
  }, [dispositivo.deviceToken]);

  async function confirmar(pinCompleto: string): Promise<void> {
    if (!elegido) return;
    setEntrando(true);
    setError(null);
    try {
      const sesion = await api.entrar(
        dispositivo.deviceToken,
        elegido.userId,
        pinCompleto,
      );
      await almacen.guardarSesion({
        accessToken: sesion.accessToken,
        refreshToken: sesion.refreshToken,
        userId: elegido.userId,
        userName: elegido.fullName,
        expiresAt: Date.now() + sesion.expiresIn * 1000,
      });
      alEntrar();
    } catch (err) {
      setPin('');
      if (err instanceof SinRed) setError('Sin conexión.');
      else if (err instanceof ApiError) setError(err.message);
      else setError('No se pudo entrar.');
    } finally {
      setEntrando(false);
    }
  }

  function teclear(d: string): void {
    if (entrando) return;
    const siguiente = (pin + d).slice(0, 6);
    setPin(siguiente);
    // Cuatro dígitos es el caso normal: se envía solo, sin botón de confirmar.
    // Quien tenga PIN más largo sigue tecleando y usa «Entrar».
    if (siguiente.length === 4) void confirmar(siguiente);
  }

  if (!elegido) {
    return (
      <div className="centrado tarjeta-grande">
        <h1>{dispositivo.deviceName}</h1>
        <p className="apunte">¿Quién va a vender?</p>
        {error ? <p className="error">{error}</p> : null}
        {operadores === null ? (
          <p className="apunte">Cargando…</p>
        ) : operadores.length === 0 ? (
          <p className="apunte">
            Nadie tiene PIN configurado todavía. Se pone desde el panel, en el
            perfil de cada persona.
          </p>
        ) : (
          <div className="rejilla-operadores">
            {operadores.map((o) => (
              <button
                key={o.userId}
                type="button"
                className="operador"
                onClick={() => {
                  setElegido(o);
                  setError(null);
                }}
              >
                {o.fullName}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="centrado tarjeta-grande">
      <h1>{elegido.fullName}</h1>
      <p className="apunte">Tu PIN</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="puntos-pin" aria-label={`PIN de ${pin.length} dígitos`}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={i < pin.length ? 'punto lleno' : 'punto'} />
        ))}
      </div>
      <div className="teclado">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              teclear(d);
            }}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className="discreto"
          onClick={() => {
            setElegido(null);
            setPin('');
          }}
        >
          Volver
        </button>
        <button
          type="button"
          onClick={() => {
            teclear('0');
          }}
        >
          0
        </button>
        <button
          type="button"
          className="discreto"
          onClick={() => {
            setPin(pin.slice(0, -1));
          }}
        >
          ←
        </button>
      </div>
      {pin.length > 4 ? (
        <button
          type="button"
          onClick={() => {
            void confirmar(pin);
          }}
          disabled={entrando}
        >
          Entrar
        </button>
      ) : null}
    </div>
  );
}
