<#
.SYNOPSIS
  Instalador del agente de impresión de Sahana Food en Windows (T4.24, ADR-0008).

.DESCRIPTION
  Windows es la mitad del parque: docs/26 recomienda «cualquier x86 con Windows
  10+ o Linux», y en la práctica la máquina del local es una laptop vieja con
  Windows.

  Se registra como servicio con `New-Service` sobre un envoltorio, sin
  dependencias externas: pedirle a quien monta un local que instale NSSM antes
  es pedirle que no lo instale.

.EXAMPLE
  .\install.ps1 -Token abcd1234abcd1234 -Printers "cocina=net:192.168.1.50:9100"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Printers,
  [int]$Port = 7443,
  [int]$Width = 48,
  [string]$Prefix = "$env:ProgramFiles\Sahana\print-agent",
  [string]$DataDir = "$env:ProgramData\Sahana",
  [switch]$NoService
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'SahanaPrintAgent'

function Morir($mensaje) { Write-Host "ERROR: $mensaje" -ForegroundColor Red; exit 1 }
function Info($mensaje)  { Write-Host "  $mensaje" }
function Bien($mensaje)  { Write-Host $mensaje -ForegroundColor Green }

# ---------------------------------------------------------------------------
# Validación previa: todo antes de tocar nada. Abortar a medias deja una
# máquina en un estado que nadie sabe deshacer.
# ---------------------------------------------------------------------------
Write-Host '== Comprobaciones previas =='

$esAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Morir 'Hay que ejecutarlo como Administrador: registra un servicio.' }

if ($Token.Length -lt 16) { Morir "El token es demasiado corto ($($Token.Length) car., mínimo 16)." }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Morir 'No hay Node.js instalado. Hace falta Node 22 o superior.' }
$nodeMayor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMayor -lt 22) { Morir "Node $nodeMayor es demasiado antiguo. Hace falta Node 22 o superior." }
Info "Node $(& node -v)"

$Origen = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$Origen\dist\main.js")) {
  Morir "No encuentro $Origen\dist\main.js. Compila antes con: pnpm --filter @sahana/print-agent build"
}
Info "Agente compilado en $Origen\dist"

# ---------------------------------------------------------------------------
# Instalación
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '== Instalando =='

New-Item -ItemType Directory -Force -Path $Prefix  | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# Se borra dist antes de copiar: una actualización no debe dejar ficheros de la
# versión anterior conviviendo con los nuevos.
if (Test-Path "$Prefix\dist") { Remove-Item -Recurse -Force "$Prefix\dist" }
Copy-Item -Recurse "$Origen\dist" "$Prefix\dist"
Copy-Item "$Origen\package.json" "$Prefix\package.json"
Info "Agente copiado a $Prefix"

$EnvFile = Join-Path $Prefix 'print-agent.env'
@(
  "AGENT_TOKEN=$Token"
  "PRINTERS=$Printers"
  "AGENT_PORT=$Port"
  "TICKET_WIDTH=$Width"
  "QUEUE_FILE=$DataDir\print-queue.json"
) | Set-Content -Path $EnvFile -Encoding UTF8

# Solo Administradores y SYSTEM: el fichero lleva el token de emparejamiento,
# que es lo único que separa a la PWA de cualquier programa de la máquina.
$acl = Get-Acl $EnvFile
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
foreach ($quien in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $quien, 'FullControl', 'Allow')))
}
Set-Acl -Path $EnvFile -AclObject $acl
Info "Configuración en $EnvFile (solo Administradores y SYSTEM)"

# Envoltorio: lee el .env y lanza el agente. Windows no tiene EnvironmentFile
# como systemd, y meter el token en las variables de la máquina lo dejaría
# visible para cualquier proceso.
$wrapper = Join-Path $Prefix 'service-wrapper.cmd'
@"
@echo off
for /f "usebackq tokens=1,* delims==" %%A in ("$EnvFile") do set "%%A=%%B"
"$($node.Source)" "$Prefix\dist\main.js"
"@ | Set-Content -Path $wrapper -Encoding ASCII

# ---------------------------------------------------------------------------
# Diagnóstico ANTES de arrancar: si algo está mal, se dice ahora, con alguien
# delante y tiempo para arreglarlo.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '== Diagnóstico =='
Get-Content $EnvFile | ForEach-Object {
  $par = $_ -split '=', 2
  if ($par.Length -eq 2) { Set-Item -Path "env:$($par[0])" -Value $par[1] }
}
& node "$Prefix\dist\main.js" doctor
if ($LASTEXITCODE -ne 0) {
  Morir 'El diagnóstico encontró problemas que impiden funcionar (arriba). No se registra el servicio.'
}

# ---------------------------------------------------------------------------
# Servicio
# ---------------------------------------------------------------------------
if (-not $NoService) {
  Write-Host ''
  Write-Host '== Registrando el servicio =='

  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
  }

  New-Service -Name $ServiceName `
    -DisplayName 'Sahana Food - Agente de impresión' `
    -Description 'Imprime comandas y precuentas en las impresoras térmicas del local. Funciona sin internet.' `
    -BinaryPathName "cmd.exe /c `"$wrapper`"" `
    -StartupType Automatic | Out-Null

  # Un corte de luz reinicia la máquina y el local tiene que volver a imprimir
  # sin que nadie toque nada. Reinicio siempre, sin rendirse.
  & sc.exe failure $ServiceName reset= 0 actions= restart/5000/restart/5000/restart/5000 | Out-Null

  Start-Service -Name $ServiceName

  $vivo = $false
  foreach ($i in 1..20) {
    try {
      Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
      $vivo = $true; break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $vivo) {
    Morir "El servicio se registró pero no responde en el puerto $Port. Mira el Visor de eventos."
  }
  Bien "Servicio $ServiceName activo y respondiendo."

  # -------------------------------------------------------------------------
  # Página de prueba: el entregable real de la instalación.
  # -------------------------------------------------------------------------
  Write-Host ''
  Write-Host '== Página de prueba =='
  $primera = ($Printers -split ',')[0].Split('=')[0]
  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/printers/test" -Method Post `
      -Headers @{ 'x-agent-token' = $Token } `
      -ContentType 'application/json' `
      -Body (@{ printer = $primera } | ConvertTo-Json) | Out-Null
    Bien "Página de prueba enviada a «$primera»."
    Write-Host ''
    Write-Host '  MIRA EL PAPEL. La instalación NO está terminada hasta que salga y'
    Write-Host '  se lea completo, con acentos y ñ correctos. Si sale «Raci?n» o'
    Write-Host '  «RaciÃ³n», la impresora no está en CP850: avisa a soporte.'
  } catch {
    Write-Host 'No se pudo encolar la página de prueba. Revisa el nombre de la impresora.' -ForegroundColor Red
  }
}

Write-Host ''
Bien 'Instalación terminada.'
Write-Host @"

  Configuración:  $EnvFile
  Datos:          $DataDir
  Agente:         http://127.0.0.1:$Port

  Ver estado:     Get-Service $ServiceName
  Diagnosticar:   node "$Prefix\dist\main.js" doctor
  Desinstalar:    .\uninstall.ps1

"@
