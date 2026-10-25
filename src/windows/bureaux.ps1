# Assistant "bureaux virtuels" de Diffusion Ecran (Windows uniquement).
# Lance une fois par l application ; recoit une commande JSON par ligne sur
# l entree standard et repond une ligne JSON : {"id": n, "result": {...}}.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Bureaux.cs')))
[Diffusion.Bureaux]::InitDpi()
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
            'place'   { $out = [Diffusion.Bureaux]::Place([long]$msg.hwnd, [int]$msg.x, [int]$msg.y, [int]$msg.width, [int]$msg.height) }
            'restore' { $out = [Diffusion.Bureaux]::Restore([long]$msg.hwnd) }
            'alive'   { $out = [Diffusion.Bureaux]::Alive([long]$msg.hwnd) }
            default  { $out = '{"ok":false,"error":"Commande inconnue."}' }
        }
    } catch {
        $out = '{"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$_.Exception.Message) -Compress) + '}'
    }
    [Console]::Out.WriteLine('{"id":' + $id + ',"result":' + $out + '}')
    [Console]::Out.Flush()
}
