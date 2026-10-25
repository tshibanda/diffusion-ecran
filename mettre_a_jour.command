#!/bin/bash
# Met a jour ce dossier depuis GitHub (tshibanda/diffusion-ecran).
# Les reglages (ecran choisi, cadrage) sont stockes dans les donnees de
# l'application, pas dans ce dossier : ils ne sont jamais touches.

pause_and_exit() {
  echo
  read -p "Appuyez sur Entree pour fermer..."
  exit "$1"
}

# Tout est dans une fonction : bash la lit entierement avant de
# l'executer, donc la mise a jour peut remplacer ce fichier sans risque.
main() {
  cd "$(cd "$(dirname "$0")" && pwd)"

  if ! command -v git >/dev/null 2>&1; then
    echo "[ERREUR] git est introuvable. Ouvrez un Terminal et lancez : xcode-select --install"
    pause_and_exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "[ERREUR] Node.js est introuvable. Installez-le depuis https://nodejs.org/"
    pause_and_exit 1
  fi

  if [ ! -d ".git" ]; then
    echo "Premiere mise a jour : rattachement au depot GitHub..."
    git init
    git remote add origin https://github.com/tshibanda/diffusion-ecran.git
  else
    echo "Depot deja rattache."
  fi

  echo "Recuperation des dernieres modifications..."
  if ! git fetch origin main; then
    echo
    echo "[ERREUR] Impossible de contacter GitHub. Verifiez la connexion internet."
    pause_and_exit 1
  fi

  git checkout -f -B main origin/main
  git branch --set-upstream-to=origin/main main >/dev/null 2>&1
  chmod +x demarrer.command mettre_a_jour.command 2>/dev/null

  echo
  echo "Installation des dependances (peut prendre quelques minutes la premiere fois)..."
  if ! npm install; then
    echo
    echo "[ERREUR] npm install a echoue. Consultez le message ci-dessus."
    pause_and_exit 1
  fi

  echo
  echo "Mise a jour terminee. Lancez demarrer.command."
  pause_and_exit 0
}

main "$@"
