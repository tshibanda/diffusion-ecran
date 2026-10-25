@echo off
REM Met a jour ce dossier depuis GitHub (tshibanda/diffusion-ecran).
REM Les reglages (ecran choisi, cadrage) sont stockes dans les donnees de
REM l'application, pas dans ce dossier : ils ne sont jamais touches.
setlocal

REM Ce fichier peut etre remplace par la mise a jour elle-meme : on
REM l'execute depuis une copie temporaire pour eviter tout comportement
REM bizarre de Windows pendant qu'il est reecrit.
if not "%~1"=="--copie" (
    copy /y "%~f0" "%TEMP%\diffusion-ecran-maj.bat" >nul
    "%TEMP%\diffusion-ecran-maj.bat" --copie "%~dp0."
)
cd /d "%~2"
title Diffusion Ecran - Mise a jour

git --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] git est introuvable. Installez-le depuis git-scm.com
    pause
    exit /b 1
)

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js est introuvable. Installez-le depuis nodejs.org
    pause
    exit /b 1
)

if not exist ".git" (
    echo Premiere mise a jour : rattachement au depot GitHub...
    git init
    git remote add origin https://github.com/tshibanda/diffusion-ecran.git
) else (
    echo Depot deja rattache.
)

echo Recuperation des dernieres modifications...
git fetch origin main
if errorlevel 1 (
    echo.
    echo [ERREUR] Impossible de contacter GitHub. Verifiez la connexion internet.
    goto :fin
)

git checkout -f -B main origin/main
git branch --set-upstream-to=origin/main main >nul 2>&1

echo.
echo Installation des dependances (peut prendre quelques minutes la premiere fois)...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo [ERREUR] npm install a echoue. Consultez le message ci-dessus.
    goto :fin
)

echo.
echo Mise a jour terminee. Lancez demarrer.bat.

:fin
echo.
pause
endlocal
