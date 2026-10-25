# Diffusion Écran

Choisir une fenêtre ouverte et la projeter en plein écran sur un second écran
branché à l'ordinateur, sans avoir à la glisser d'un écran à l'autre.
Fonctionne sous Windows et macOS.

## Utilisation

1. Lancez `demarrer.bat` (Windows) ou `demarrer.command` (Mac).
2. Cliquez sur une fenêtre dans la liste : son aperçu en direct s'affiche à droite.
   L'onglet « Écrans entiers » permet aussi de diffuser tout un écran.
3. Choisissez l'écran de projection (le second écran est proposé par défaut)
   et le cadrage.
4. Appuyez sur **▶ Diffuser**. Un double-clic sur une fenêtre la diffuse directement.
5. Pendant la diffusion, cliquez sur une autre fenêtre puis **Diffuser à la place**
   pour basculer sans écran noir. **■ Arrêter** (ou la touche Échap sur l'écran de
   projection) coupe la diffusion.

La fenêtre diffusée doit rester ouverte et non réduite (elle peut être cachée
derrière d'autres fenêtres).

## Installation et mise à jour

Prérequis : [Git](https://git-scm.com) et [Node.js](https://nodejs.org).

Placez `mettre_a_jour.bat` (Windows) ou `mettre_a_jour.command` (Mac) dans un
dossier, puis lancez-le : il télécharge l'application depuis GitHub et installe
ses dépendances. Relancez-le à chaque fois que vous voulez la dernière version.

Sur Mac, au premier lancement, autorisez l'application dans
**Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran**,
puis relancez-la. L'application affiche un bouton pour ouvrir ce réglage.
