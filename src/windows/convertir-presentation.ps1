# Convertit une presentation en images PNG (une par diapositive visible) avec
# PowerPoint, sans l'afficher. Ecrit le nombre d'images sur la sortie standard.
# Si PowerPoint etait deja ouvert, il n'est pas ferme (les documents de
# l'utilisateur restent ouverts).
param(
    [Parameter(Mandatory = $true)][string]$Fichier,
    [Parameter(Mandatory = $true)][string]$Dossier
)
$ErrorActionPreference = 'Stop'

$dejaOuvert = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
try {
    # Lecture seule (-1), pas de copie sans titre (0), pas de fenetre (0).
    $pres = $app.Presentations.Open($Fichier, -1, 0, 0)
    try {
        $largeur = 1920
        $hauteur = [int][Math]::Round($largeur * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
        $n = 0
        foreach ($diapo in $pres.Slides) {
            # Les diapositives masquees ne sont pas montrees en diaporama.
            if ($diapo.SlideShowTransition.Hidden -eq -1) { continue }
            $n++
            $diapo.Export((Join-Path $Dossier "$n.png"), 'PNG', $largeur, $hauteur)
        }
        Write-Output $n
    }
    finally {
        $pres.Close()
    }
}
finally {
    if (-not $dejaOuvert) { $app.Quit() }
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
