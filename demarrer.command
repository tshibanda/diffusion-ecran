#!/bin/bash
# Lance Diffusion Ecran.
cd "$(cd "$(dirname "$0")" && pwd)"

ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON" ]; then
  echo "[ERREUR] L'application n'est pas encore installee."
  echo "Lancez d'abord mettre_a_jour.command."
  read -p "Appuyez sur Entree pour fermer..."
  exit 1
fi

nohup "$ELECTRON" . >/dev/null 2>&1 &
disown
exit 0
