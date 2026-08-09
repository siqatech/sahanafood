import { useEffect, useState } from 'react';
import { almacen } from '../lib/db';
import {
  impresion,
  ImpresionNoDisponible,
  type ConfiguracionDeImpresion,
  type SaludDeImpresion,
} from '../lib/impresion';

/**
 * Impresoras: a qué agente habla esta tablet y con qué impresoras (ux/01).
 *
 * Es configuración **del dispositivo** y no del negocio: la IP del agente y el
 * nombre de la impresora dependen de la red del local y de qué cable va a qué
 * aparato. Un catálogo de impresoras en el servidor no sabría en qué wifi está
 * esta tablet.
 *
 * La pantalla enseña la salud del agente en vez de un «guardado» y ya: lo que
 * el operador necesita saber es si la impresora responde, y eso solo se
 * averigua preguntando.
 */
export function Impresoras() {
  const [cfg, setCfg] = useState<ConfiguracionDeImpresion>({
    baseUrl: 'http://127.0.0.1:7443',
    token: '',
    impresoraCocina: 'cocina',
    impresoraMostrador: 'mostrador',
  });
  const [salud, setSalud] = useState<SaludDeImpresion | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);

  useEffect(() => {
    void almacen.impresion().then((guardada) => {
      if (guardada) setCfg(guardada);
    });
  }, []);

  async function guardarYProbar(): Promise<void> {
    setProbando(true);
    setError(null);
    setMensaje(null);
    await almacen.guardarImpresion(cfg);
    try {
      setSalud(await impresion.salud(cfg));
      setMensaje('Guardado. El agente responde.');
    } catch (err) {
      setSalud(null);
      setError(
        err instanceof ImpresionNoDisponible
          ? err.message
          : 'No se pudo hablar con el agente.',
      );
    } finally {
      setProbando(false);
    }
  }

  return (
    <div className="centrado tarjeta-grande">
      <h1>Impresoras</h1>
      <p className="apunte">
        El agente de impresión corre en la computadora de la caja, en esta misma
        red. Por eso imprimir funciona aunque no haya internet.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {mensaje ? <p className="apunte">{mensaje}</p> : null}

      <label htmlFor="agente">Dirección del agente</label>
      <input
        id="agente"
        value={cfg.baseUrl}
        onChange={(e) => {
          setCfg({ ...cfg, baseUrl: e.target.value });
        }}
        placeholder="http://192.168.1.50:7443"
      />

      <label htmlFor="token">Token del agente</label>
      <input
        id="token"
        type="password"
        value={cfg.token}
        onChange={(e) => {
          setCfg({ ...cfg, token: e.target.value });
        }}
      />

      <label htmlFor="cocina">Impresora de cocina</label>
      <input
        id="cocina"
        value={cfg.impresoraCocina}
        onChange={(e) => {
          setCfg({ ...cfg, impresoraCocina: e.target.value });
        }}
      />

      <label htmlFor="mostrador">Impresora del mostrador</label>
      <input
        id="mostrador"
        value={cfg.impresoraMostrador}
        onChange={(e) => {
          setCfg({ ...cfg, impresoraMostrador: e.target.value });
        }}
      />

      <button
        type="button"
        disabled={probando}
        onClick={() => {
          void guardarYProbar();
        }}
      >
        {probando ? 'Probando…' : 'Guardar y probar'}
      </button>

      {salud ? (
        <div className="ficha-agente">
          <p className="apunte">
            {salud.pendingJobs} en cola · {salud.failedJobs} con fallo
          </p>
          {salud.printers.map((p) => (
            <p key={p.printer}>
              {/* Ícono Y texto, nunca solo color: en un mostrador con luz
                  directa el verde y el rojo se parecen (docs/25 §6). */}
              {p.reachable ? '● ' : '▲ '}
              <strong>{p.printer}</strong>{' '}
              {p.reachable ? 'responde' : 'no responde'}
            </p>
          ))}
          {salud.printers.length === 0 ? (
            <p className="apunte">
              El agente no tiene ninguna impresora configurada. Se declaran al
              instalarlo, en su propio archivo de configuración.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
