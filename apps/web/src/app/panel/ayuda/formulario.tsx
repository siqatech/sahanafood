'use client';

import { useState } from 'react';
import { construirMensaje, enlaceDeWhatsApp } from './mensaje';
import type { ContextoDeSoporte } from './mensaje';

/**
 * El formulario de ayuda.
 *
 * Es cliente y no servidor porque el mensaje se compone MIENTRAS se escribe:
 * la promesa de la pantalla es «ves lo que mandas», y eso no se cumple con una
 * vista previa que llega después de pulsar un botón.
 *
 * No manda nada a nuestro servidor. Abre WhatsApp con el texto ya escrito y el
 * envío lo hace la persona desde su propia cuenta, que es lo que le permite
 * arrepentirse al leerlo.
 */
export function FormularioDeAyuda({
  contexto,
  numeroDeSoporte,
}: {
  contexto: ContextoDeSoporte;
  numeroDeSoporte: string | undefined;
}) {
  const [texto, setTexto] = useState('');
  const [codigo, setCodigo] = useState('');
  const [adjuntar, setAdjuntar] = useState(true);
  const [copiado, setCopiado] = useState(false);

  const mensaje = construirMensaje({
    texto,
    contexto: { ...contexto, codigoDeError: codigo },
    adjuntarDatos: adjuntar,
  });
  const enlace = enlaceDeWhatsApp(numeroDeSoporte, mensaje);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(mensaje);
      setCopiado(true);
    } catch {
      // Sin permiso de portapapeles no se puede hacer nada útil, y un aviso de
      // error aquí sería ruido: el texto está a la vista y se puede
      // seleccionar a mano.
      setCopiado(false);
    }
  }

  return (
    <div className="ayuda">
      <div className="campo">
        <label htmlFor="ayuda-texto">¿Qué está pasando?</label>
        <textarea
          id="ayuda-texto"
          rows={4}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Cuéntanoslo como se lo contarías a un compañero."
        />
      </div>

      <div className="campo">
        <label htmlFor="ayuda-codigo">Código del error (si lo tienes)</label>
        <input
          id="ayuda-codigo"
          className="corto"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="01M0QMMG9Y42EK5"
        />
        <span className="tarjeta__pie">
          Cuando algo falla, la pantalla enseña un código. Con él encontramos
          exactamente esa operación en vez de buscar a ciegas.
        </span>
      </div>

      {/* La confirmación de docs/26. Marcada por defecto —sin datos, atender
          cuesta el triple— pero VISIBLE y desmarcable, y con los datos
          escritos debajo tal cual salen. */}
      <label className="ayuda__casilla">
        <input
          type="checkbox"
          checked={adjuntar}
          onChange={(e) => setAdjuntar(e.target.checked)}
        />
        <span>Adjuntar los datos de mi negocio y mi versión del programa</span>
      </label>

      <div className="ayuda__vista">
        <p className="ayuda__vista-titulo">Esto es lo que se manda:</p>
        <pre className="ayuda__previa">{mensaje}</pre>
        <span className="tarjeta__pie">
          No se adjunta ningún dato de tus clientes: ni nombres, ni teléfonos,
          ni direcciones, ni pedidos.
        </span>
      </div>

      <div className="ayuda__acciones">
        {enlace ? (
          <a
            className="boton-enlace"
            href={enlace}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir WhatsApp
          </a>
        ) : (
          <p className="panel__error">
            Todavía no hay un número de soporte configurado. Copia el mensaje y
            mándalo por el canal que uses con nosotros.
          </p>
        )}
        <button type="button" className="discreto" onClick={copiar}>
          {copiado ? 'Copiado' : 'Copiar el mensaje'}
        </button>
      </div>
    </div>
  );
}
