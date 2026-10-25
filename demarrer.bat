@echo off
REM Lance Diffusion Ecran.
cd /d "%~dp0"

if not exist "node_modules\electron\install.js" (
    echo [ERREUR] L'application n'est pas encore installee.
    echo Lancez d'abord mettre_a_jour.bat.
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo Premier lancement : telechargement du moteur de l'application...
    node node_modules\electron\install.js
    if not exist "node_modules\electron\dist\electron.exe" (
        echo.
        echo [ERREUR] Le telechargement a echoue. Verifiez la connexion internet
        echo puis relancez mettre_a_jour.bat.
        pause
        exit /b 1
    )
)

start "" "node_modules\electron\dist\electron.exe" .
