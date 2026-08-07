<#
.SYNOPSIS
  Desinstalador del agente de impresión en Windows.

.DESCRIPTION
  Conserva los datos por defecto. Un desinstalador que borra la cola se lleva
  por delante comandas que nunca llegaron a imprimirse, y el motivo habitual
  para desinstalar es reinstalar.
#>
[CmdletBinding()]
param(
  [string]$Prefix = "$env:ProgramFiles\Sahana\print-agent",
  [string]$DataDir = "$env:ProgramData\Sahana",
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'SahanaPrintAgent'

$esAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Write-Host 'Hay que ejecutarlo como Administrador.' -ForegroundColor Red; exit 1 }

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $ServiceName | Out-Null
  Write-Host '  Servicio detenido y desregistrado.'
}

if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix }
Write-Host "  Agente borrado de $Prefix"

if ($Purge) {
  if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
  Write-Host '  Datos y configuración borrados.'
} else {
  $pendientes = 0
  $cola = Join-Path $DataDir 'print-queue.json'
  if (Test-Path $cola) {
    try {
      $pendientes = @(Get-Content $cola -Raw | ConvertFrom-Json |
        Where-Object { $_.status -ne 'done' }).Count
    } catch { $pendientes = 0 }
  }
  Write-Host "  Datos CONSERVADOS en $DataDir ($pendientes trabajo(s) sin imprimir)."
  Write-Host '  Usa -Purge para borrarlos.'
}

Write-Host 'Desinstalación terminada.'
