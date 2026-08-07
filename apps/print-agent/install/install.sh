#!/usr/bin/env bash
#
# Instalador del agente de impresión de Sahana Food (T4.24, ADR-0008).
#
# Lo ejecuta quien monta el local, no un desarrollador. Por eso:
#
#  · Pregunta lo mínimo y valida TODO antes de tocar nada. Un instalador que
#    deja el sistema a medias es peor que uno que no arranca.
#  · Termina imprimiendo una página de prueba. «El servicio arrancó» no prueba
#    nada —arranca igual con la impresora apagada—; lo que cierra la
#    instalación es un papel en la mano.
#  · Es idempotente: volver a ejecutarlo actualiza en vez de duplicar. Se
#    reinstala más de lo que se instala.
#
# Uso:
#   sudo ./install.sh --token <TOKEN> --printers "cocina=net:192.168.1.50:9100"
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/sahana/print-agent}"
SERVICE_NAME="sahana-print-agent"
SERVICE_USER="${SERVICE_USER:-sahana}"
DATA_DIR="${DATA_DIR:-/var/lib/sahana}"
ENV_FILE="/etc/sahana/print-agent.env"
PUERTO="7443"
ANCHO="48"
TOKEN=""
PRINTERS=""
SIN_SERVICIO="no"

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

morir() { rojo "ERROR: $*"; exit 1; }

uso() {
  cat <<'AYUDA'
Instalador del agente de impresión de Sahana Food.

  --token <TOKEN>        Token de emparejamiento (mín. 16 car.). Sale del panel.
  --printers <SPEC>      Impresoras: nombre=net:host:puerto o nombre=file:/ruta,
                         separadas por coma.
  --port <N>             Puerto local del agente (por defecto 7443).
  --width <N>            Caracteres por línea: 32 (papel 58 mm) o 48 (80 mm).
  --no-service           Instala los ficheros pero no registra el servicio.
  --help                 Esta ayuda.

Ejemplo:
  sudo ./install.sh --token abcd1234abcd1234 \
       --printers "cocina=net:192.168.1.50:9100,caja=file:/dev/usb/lp0"
AYUDA
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)    TOKEN="${2:-}"; shift 2 ;;
    --printers) PRINTERS="${2:-}"; shift 2 ;;
    --port)     PUERTO="${2:-}"; shift 2 ;;
    --width)    ANCHO="${2:-}"; shift 2 ;;
    --no-service) SIN_SERVICIO="si"; shift ;;
    --help|-h)  uso; exit 0 ;;
    *) morir "Opción desconocida: $1. Usa --help." ;;
  esac
done

# ---------------------------------------------------------------------------
# Validación previa. Todo lo que pueda fallar se comprueba ANTES de copiar un
# solo fichero: abortar a medias deja una máquina en un estado que nadie sabe
# deshacer.
# ---------------------------------------------------------------------------
echo "== Comprobaciones previas =="

[[ $EUID -eq 0 ]] || morir "Hay que ejecutarlo con sudo: registra un servicio del sistema."

[[ -n "$TOKEN" ]] || morir "Falta --token. Lo genera el panel al emparejar la caja."
[[ ${#TOKEN} -ge 16 ]] || morir "El token es demasiado corto (${#TOKEN} car., mínimo 16)."
[[ -n "$PRINTERS" ]] || morir "Falta --printers. Sin impresoras el agente no sirve de nada."

command -v node >/dev/null 2>&1 || morir "No hay Node.js instalado. Hace falta Node 22 o superior."
NODE_MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAYOR" -ge 22 ]] || morir "Node $NODE_MAYOR es demasiado antiguo. Hace falta Node 22 o superior."
info "Node $(node -v)"

ORIGEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$ORIGEN/dist/main.js" ]] || morir \
  "No encuentro $ORIGEN/dist/main.js. Compila antes con: pnpm --filter @sahana/print-agent build"
info "Agente compilado en $ORIGEN/dist"

USA_SYSTEMD="no"
if [[ "$SIN_SERVICIO" == "no" ]]; then
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    USA_SYSTEMD="si"
  else
    # Se dice claramente en vez de fallar: hay máquinas de local sin systemd, y
    # el agente funciona igual arrancado a mano.
    rojo "AVISO: esta máquina no usa systemd. Se instalan los ficheros y se"
    rojo "       explica cómo arrancarlo, pero no se registra ningún servicio."
  fi
fi

# ---------------------------------------------------------------------------
# Instalación
# ---------------------------------------------------------------------------
echo
echo "== Instalando =="

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # Usuario sin shell ni login: el agente no necesita ninguna de las dos, y un
  # servicio que corre como root es una superficie de ataque regalada.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  info "Usuario de servicio «$SERVICE_USER» creado"
else
  info "Usuario de servicio «$SERVICE_USER» ya existe"
fi

install -d -m 755 "$PREFIX"
# `rsync`-menos: se borra dist y se copia, para que una actualización no deje
# ficheros viejos de la versión anterior conviviendo con los nuevos.
rm -rf "$PREFIX/dist"
cp -r "$ORIGEN/dist" "$PREFIX/dist"
cp "$ORIGEN/package.json" "$PREFIX/package.json"
info "Agente copiado a $PREFIX"

install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
info "Datos en $DATA_DIR"

install -d -m 750 /etc/sahana
# 640 y del usuario del servicio: el fichero lleva el token de emparejamiento,
# que es lo único que separa a la PWA de cualquier pestaña abierta en la misma
# máquina.
umask 077
cat > "$ENV_FILE" <<ENV
AGENT_TOKEN=$TOKEN
PRINTERS=$PRINTERS
AGENT_PORT=$PUERTO
TICKET_WIDTH=$ANCHO
QUEUE_FILE=$DATA_DIR/print-queue.json
ENV
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
info "Configuración en $ENV_FILE (modo 640)"

# ---------------------------------------------------------------------------
# Diagnóstico ANTES de arrancar: si algo está mal, se dice ahora, con alguien
# delante y tiempo para arreglarlo.
# ---------------------------------------------------------------------------
echo
echo "== Diagnóstico =="
set +e
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
node "$PREFIX/dist/main.js" doctor
DIAGNOSTICO=$?
set -e
[[ $DIAGNOSTICO -eq 0 ]] || morir "El diagnóstico encontró problemas que impiden funcionar (arriba). No se registra el servicio."

# ---------------------------------------------------------------------------
# Servicio
# ---------------------------------------------------------------------------
if [[ "$USA_SYSTEMD" == "si" ]]; then
  echo
  echo "== Registrando el servicio =="
  sed -e "s|@PREFIX@|$PREFIX|g" \
      -e "s|@USER@|$SERVICE_USER|g" \
      -e "s|@ENV_FILE@|$ENV_FILE|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" \
      "$ORIGEN/install/$SERVICE_NAME.service" > "/etc/systemd/system/$SERVICE_NAME.service"

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"

  # Se espera al servicio antes de cantar victoria: `restart` vuelve en cuanto
  # lanza el proceso, no en cuanto el proceso funciona.
  for _ in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$PUERTO/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done

  if ! curl -sf "http://127.0.0.1:$PUERTO/health" >/dev/null 2>&1; then
    rojo "El servicio se registró pero no responde en el puerto $PUERTO."
    rojo "Mira qué pasó con:  journalctl -u $SERVICE_NAME -n 50"
    exit 1
  fi
  verde "Servicio $SERVICE_NAME activo y respondiendo."
fi

# ---------------------------------------------------------------------------
# Página de prueba: el entregable real de la instalación.
# ---------------------------------------------------------------------------
echo
echo "== Página de prueba =="
PRIMERA="$(echo "$PRINTERS" | cut -d, -f1 | cut -d= -f1)"
if [[ "$USA_SYSTEMD" == "si" ]]; then
  if curl -sf -X POST "http://127.0.0.1:$PUERTO/printers/test" \
       -H "content-type: application/json" \
       -H "x-agent-token: $TOKEN" \
       -d "{\"printer\":\"$PRIMERA\"}" >/dev/null; then
    verde "Página de prueba enviada a «$PRIMERA»."
    echo
    echo "  MIRA EL PAPEL. La instalación NO está terminada hasta que salga y"
    echo "  se lea completo, con acentos y ñ correctos. Si sale «Raci?n» o"
    echo "  «RaciÃ³n», la impresora no está en CP850: avisa a soporte."
  else
    rojo "No se pudo encolar la página de prueba. Revisa el nombre de la impresora."
  fi
else
  info "Sin servicio registrado: arranca el agente y pide la prueba a mano."
fi

echo
verde "Instalación terminada."
cat <<FIN

  Configuración:  $ENV_FILE
  Datos:          $DATA_DIR
  Agente:         http://127.0.0.1:$PUERTO

  Ver estado:     systemctl status $SERVICE_NAME
  Ver registro:   journalctl -u $SERVICE_NAME -f
  Diagnosticar:   sudo node $PREFIX/dist/main.js doctor
  Desinstalar:    sudo ./uninstall.sh

FIN
