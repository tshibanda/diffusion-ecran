# Son d'une seule application (celle de la fenetre diffusee) pour le flux OBS.
# Ecrit le son en continu sur la sortie standard (PCM 16 bits, 48 kHz, stereo).
# Voir SonFenetre.cs.
param(
    [Parameter(Mandatory = $true)][long]$Hwnd
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'SonFenetre.cs')))
exit [Diffusion.SonFenetre]::Run($Hwnd)
