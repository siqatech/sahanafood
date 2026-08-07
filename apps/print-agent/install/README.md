# Instalación del agente de impresión (T4.24)

Procedimiento para dejar el agente corriendo como servicio en la máquina del
local. Lo ejecuta quien monta el local, no un desarrollador.

## Antes de ir al local

1. **Node.js 22 o superior** en la máquina. Es el único requisito previo: el
   agente **no tiene ninguna dependencia de ejecución**, así que la instalación
   es copiar una carpeta (hay una prueba que lo verifica; ver
   `src/api/validation.test.ts`).
2. **Token de emparejamiento**, del panel. Mínimo 16 caracteres.
3. **Cómo está conectada cada impresora.** Si no se sabe, el agente escanea la
   red: ver «Encontrar la impresora» más abajo.
4. **El paquete compilado**: `pnpm --filter @sahana/print-agent build`. El
   instalador se niega a continuar sin `dist/`.

## Linux (systemd)

```bash
sudo ./install.sh \
  --token abcd1234abcd1234 \
  --printers "cocina=net:192.168.1.50:9100,caja=file:/dev/usb/lp0" \
  --width 48
```

`--width 48` es papel de 80 mm; `--width 32`, de 58 mm.

Qué hace, en orden:

1. **Comprueba todo antes de tocar nada** — root, token, Node, `dist/`. Un
   instalador que aborta a medias deja la máquina en un estado que nadie sabe
   deshacer.
2. Crea el usuario de servicio `sahana`, sin shell ni login.
3. Copia el agente a `/opt/sahana/print-agent` y escribe
   `/etc/sahana/print-agent.env` en modo `640`. Ese fichero lleva el token: es
   lo único que separa a la PWA de cualquier programa de la máquina.
4. **Ejecuta el diagnóstico y aborta si falla.** Ver más abajo.
5. Registra y arranca el servicio, y **espera a que responda** — `systemctl
   restart` vuelve en cuanto lanza el proceso, no en cuanto el proceso funciona.
6. **Imprime la página de prueba.**

Volver a ejecutarlo actualiza en vez de duplicar: se reinstala más de lo que se
instala.

## Windows

```powershell
.\install.ps1 -Token abcd1234abcd1234 `
  -Printers "cocina=net:192.168.1.50:9100" -Width 48
```

Mismo flujo. Se registra como servicio con `New-Service` sobre un envoltorio
`.cmd`, sin NSSM ni ninguna otra dependencia: pedirle a quien monta un local que
instale una herramienta más antes es pedirle que no la instale.

El envoltorio existe porque Windows no tiene `EnvironmentFile` como systemd, y
meter el token en las variables de la máquina lo dejaría visible para cualquier
proceso.

## La instalación no termina hasta que sale el papel

**Este es el punto de todo el procedimiento.** «El servicio arrancó» no prueba
nada: el agente arranca igual con la impresora apagada, con el disco lleno y con
el puerto ocupado.

La página de prueba no dice «OK». Ejercita a propósito lo que se rompe en una
térmica recién conectada:

| Lo que imprime | Qué delata si sale mal |
|---|---|
| «Ración», «ñandú», «¿Añadir guarnición?» | Tabla de caracteres. Si sale «Raci?n» o «RaciÃ³n», **todas** las comandas saldrán así |
| Una regla numerada de ancho completo | Papel de 58 mm configurado como de 80 (o al revés): la regla no acaba en el borde |
| Doble alto, doble tamaño y negrita | Lo que hace legible una comanda a un metro |
| El corte final | Si el ticket sale cortado, faltan avances antes de la cuchilla |

Ninguna línea de esa página puede desbordarse — hay una prueba que lo fija para
32, 42 y 48 columnas. Si se desbordara, no se podría distinguir «se partió
porque el ancho está mal» de «se partió porque el texto era largo», que es justo
lo que la página existe para decidir.

## Diagnóstico

```bash
sudo node /opt/sahana/print-agent/dist/main.js doctor
```

Sale con código ≠ 0 si hay algo que impide funcionar, para que un script pueda
abortar sin interpretar el texto.

| Comprobación | Si falla |
|---|---|
| Node ≥ 22 | **FALLA** |
| Configuración válida | **FALLA** (y corta ahí: los errores derivados esconden el que importa) |
| La cola se puede escribir *de verdad* (escribe y borra un fichero) | **FALLA** — el agente arrancaría igual y perdería todos los trabajos al primer reinicio |
| Puerto libre | AVISO — si el agente ya corre, es lo normal |
| Impresora responde | AVISO — puede estar apagada mientras se instala; los trabajos esperan en la cola |

> `sudo` reescribe el `PATH`. Si la máquina tiene varias versiones de Node, el
> instalador puede ver una distinta de la de tu sesión — y lo dice en vez de
> fallar más tarde.

## Encontrar la impresora

La IP de una térmica no está escrita en ninguna parte: hay que sacarla del menú
de la propia impresora. Con el agente corriendo:

```bash
curl -s -H "x-agent-token: $TOKEN" \
  "http://127.0.0.1:7443/printers/discover"
```

Escanea el puerto 9100 en las redes locales de la máquina. Es deliberadamente
tonto —un `connect` TCP— porque no hay descubrimiento estándar que funcione en
las térmicas genéricas del mercado peruano: SNMP está a medias y mDNS casi
nunca; el 9100 lo soportan todas, porque es por donde reciben los tickets.

## Desinstalar

```bash
sudo ./uninstall.sh            # conserva la cola
sudo ./uninstall.sh --purge    # borra también datos y configuración
```

Por defecto **conserva los datos y dice cuántos trabajos quedaron sin
imprimir**. Un desinstalador que borra la cola se lleva por delante comandas que
nunca salieron, y el motivo habitual para desinstalar es reinstalar.

## Qué queda pendiente

- **Ejecución sobre hardware real.** Las notas de planificación de
  `specs/phases/phase-4-operacion.md` declaran T4.24 entregable humano: hace
  falta una máquina limpia y una impresora física. Lo verificado aquí es el
  procedimiento completo en Linux (instalar → diagnosticar → arrancar → imprimir
  → desinstalar), con la impresora simulada como fichero de dispositivo, que es
  literalmente cómo se escribe a una térmica USB en Linux.
- **`install.ps1` no se ha ejecutado en Windows**, por el mismo motivo.
- **Auto-actualización firmada** (ADR-0008). Hoy actualizar es volver a
  ejecutar el instalador con el `dist/` nuevo.
