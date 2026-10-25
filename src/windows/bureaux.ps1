# Assistant "bureaux virtuels" de Diffusion Ecran (Windows uniquement).
# Lance une fois par l application ; recoit une commande JSON par ligne sur
# l entree standard et repond une ligne JSON : {"id": n, "result": {...}}.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Bureaux.cs')))
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $id = 0
    try {
        $msg = $line | ConvertFrom-Json
        $id = [int]$msg.id
        switch ($msg.cmd) {
            'list'   { $out = [Diffusion.Bureaux]::List([int]$msg.pid) }
            'pin'    { $out = [Diffusion.Bureaux]::Pin([long]$msg.hwnd, $true) }
            'unpin'  { $out = [Diffusion.Bureaux]::Pin([long]$msg.hwnd, $false) }
            'switch' { $out = [Diffusion.Bureaux]::SwitchTo([string]$msg.desktop) }
            default  { $out = '{"ok":false,"error":"Commande inconnue."}' }
        }
    } catch {
        $out = '{"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$_.Exception.Message) -Compress) + '}'
    }
    [Console]::Out.WriteLine('{"id":' + $id + ',"result":' + $out + '}')
    [Console]::Out.Flush()
}
