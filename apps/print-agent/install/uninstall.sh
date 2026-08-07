#!/usr/bin/env bash
#
# Desinstalador del agente de impresión.
#
# Conserva los datos por defecto. Un desinstalador que borra la cola se lleva
# por delante comandas que nunca llegaron a imprimirse, y el motivo habitual
# para desinstalar es reinstalar. Hay que pedir el borrado a propósito.
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/sahana/print-agent}"
SERVICE_NAME="sahana-print-agent"
DATA_DIR="${DATA_DIR:-/var/lib/sahana}"
ENV_FILE="/etc/sahana/print-agent.env"
BORRAR_DATOS="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) BORRAR_DATOS="si"; shift ;;
    --help|-h)
      echo "Uso: sudo ./uninstall.sh [--purge]"
      echo "  --purge  borra también la cola de impresión y la configuración."
      exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Hay que ejecutarlo con sudo." >&2; exit 1; }

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  echo "  Servicio detenido y desregistrado."
fi

rm -rf "$PREFIX"
echo "  Agente borrado de $PREFIX"

if [[ "$BORRAR_DATOS" == "si" ]]; then
  rm -rf "$DATA_DIR" /etc/sahana
  echo "  Datos y configuración borrados."
else
  PENDIENTES=0
  if [[ -f "$DATA_DIR/print-queue.json" ]]; then
    PENDIENTES="$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        console.log(j.filter((x) => x.status !== "done").length);
      } catch { console.log(0); }
    ' "$DATA_DIR/print-queue.json" 2>/dev/null || echo 0)"
  fi
  echo "  Datos CONSERVADOS en $DATA_DIR ($PENDIENTES trabajo(s) sin imprimir)."
  echo "  Usa --purge para borrarlos."
fi

echo "Desinstalación terminada."
