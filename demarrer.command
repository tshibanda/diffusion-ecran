#!/bin/bash
# Lance Diffusion Ecran.
cd "$(cd "$(dirname "$0")" && pwd)"

ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -f node_modules/electron/install.js ]; then
  echo "[ERREUR] L'application n'est pas encore installee."
  echo "Lancez d'abord mettre_a_jour.command."
  read -p "Appuyez sur Entree pour fermer..."
  exit 1
fi

if [ ! -x "$ELECTRON" ]; then
  echo "Premier lancement : telechargement du moteur de l'application..."
  node node_modules/electron/install.js
  if [ ! -x "$ELECTRON" ]; then
    echo
    echo "[ERREUR] Le telechargement a echoue. Verifiez la connexion internet"
    echo "puis relancez mettre_a_jour.command."
    read -p "Appuyez sur Entree pour fermer..."
    exit 1
  fi
fi

nohup "$ELECTRON" . >/dev/null 2>&1 &
disown
exit 0
