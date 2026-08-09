import { useState } from 'react';
import { api, ApiError, SinRed } from '../lib/api';
import { almacen } from '../lib/db';

/**
 * Emparejar la tablet (RN-IDN-04).
 *
 * Se hace **una vez en la vida del dispositivo**, con un código de un solo uso
 * que emite alguien con permiso de gestión desde el panel. A partir de ahí la
 * tablet guarda su `deviceToken` y esta pantalla no vuelve a verse.
 */
export function Emparejar({ alEmparejar }: { alEmparejar: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const d = await api.emparejar(codigo.trim().toUpperCase(), nombre.trim());
      await almacen.guardarDispositivo({
        deviceToken: d.deviceToken,
        deviceId: d.deviceId,
        deviceName: d.name,
        locationId: d.locationId,
      });
      alEmparejar();
    } catch (err) {
      if (err instanceof SinRed) {
        setError('Sin conexión. Emparejar necesita internet una sola vez.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('No se pudo emparejar. Inténtalo de nuevo.');
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="centrado tarjeta-grande" onSubmit={enviar}>
      <h1>Emparejar esta tablet</h1>
      <p className="apunte">
        Pide el código en el panel: Configuración → Dispositivos. Vale una sola
        vez y caduca.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <label htmlFor="codigo">Código</label>
      <input
        id="codigo"
        className="grande"
        value={codigo}
        onChange={(e) => {
          setCodigo(e.target.value);
        }}
        autoCapitalize="characters"
        autoComplete="off"
        required
      />
      <label htmlFor="nombre">Nombre de esta tablet</label>
      <input
        id="nombre"
        value={nombre}
        onChange={(e) => {
          setNombre(e.target.value);
        }}
        placeholder="Caja 1"
        required
      />
      <button type="submit" disabled={enviando}>
        {enviando ? 'Emparejando…' : 'Emparejar'}
      </button>
    </form>
  );
}
