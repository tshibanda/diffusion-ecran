@echo off
REM Lance Diffusion Ecran.
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo [ERREUR] L'application n'est pas encore installee.
    echo Lancez d'abord mettre_a_jour.bat.
    pause
    exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
