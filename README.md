# Diffusion Écran

Choisir une fenêtre ouverte et la projeter en plein écran sur un second écran
branché à l'ordinateur, sans avoir à la glisser d'un écran à l'autre.
Fonctionne sous Windows et macOS.

## Utilisation

1. Lancez `demarrer.bat` (Windows) ou `demarrer.command` (Mac).
2. Choisissez l'écran de projection (le second écran est proposé par défaut).
3. Appuyez sur **▶ Diffuser**. **■ Arrêter** (ou la touche Échap sur l'écran de
   projection) coupe la diffusion.

### Diffuser une fenêtre

- Onglet **Fenêtres** (ou **Écrans entiers**) : cliquez sur une fenêtre, son aperçu
  en direct s'affiche à droite. Un double-clic la diffuse directement.
- **Plein écran d'une partie de la fenêtre** (par exemple la vidéo dans une fenêtre
  Chrome sur YouTube) : tracez un rectangle sur l'aperçu avec la souris. Seule cette
  zone est envoyée, en plein écran, sur l'écran de projection. Le bouton
  « Fenêtre entière » annule la sélection. On peut la modifier pendant la diffusion.
- Pendant la diffusion, cliquez sur une autre fenêtre puis **Diffuser à la place**
  pour basculer sans écran noir.

La fenêtre diffusée doit rester ouverte et non réduite (elle peut être cachée
derrière d'autres fenêtres).

### Diffuser une fenêtre sous Windows (même sur un autre bureau)

- **Diffuser** place la fenêtre choisie en plein écran sur l'écran de projection. C'est
  la fenêtre elle-même qui s'y affiche : une vidéo YouTube en lecture dans Chrome
  continue de jouer normalement, même si cette fenêtre était sur un autre bureau.
- **Arrêter** (ou diffuser autre chose, ou fermer l'application) remet la fenêtre
  comme avant : position, taille, plein écran, réduite/agrandie et bureau.
- Aucune touche ni aucun clic n'est simulé, et la fenêtre n'est pas mise au premier
  plan.
- Fenêtre déjà sur le bureau affiché : aucun bureau n'est touché, elle est seulement
  placée sur l'écran de projection. Fenêtre d'un autre bureau : Windows ne la dessine pas
  tant que ce bureau n'est pas affiché ; elle est donc visible sur le bureau actuel le
  temps de la diffusion, puis retrouve son bureau à l'arrêt. Pour YouTube sans aucun
  changement, utilisez **Parcourir YouTube**.
- Si vous tracez une zone sur l'aperçu, la fenêtre reste à sa place et seule la zone
  est copiée sur l'écran de projection : la fenêtre doit alors rester visible sur le
  bureau affiché (Windows ne dessine pas les fenêtres des autres bureaux).

### Bureaux virtuels de Windows (Windows + Tab)

- Dans l'onglet **Fenêtres**, la barre **Bureaux** liste vos bureaux (avec leur nom
  s'ils en ont un). Le point orange indique le bureau affiché en ce moment.
- Cliquez sur un autre bureau pour voir ses fenêtres, puis sur une fenêtre pour la
  diffuser. Cliquer sur **Diffuser** ne fait pas changer de bureau.

### Diffuser une vidéo YouTube

- **Parcourir YouTube** (onglet YouTube) ouvre un navigateur YouTube intégré : recherchez
  et ouvrez la vidéo comme dans Chrome, puis **▶ Diffuser cette vidéo**. Elle passe en
  plein écran sur l'écran de projection, au moment où vous en étiez, et se met en pause
  dans le navigateur. **■ Arrêter** coupe la diffusion.
- Onglet **YouTube** : collez le lien de la vidéo (Entrée ou **▶ Diffuser**).
- La vidéo s'ouvre directement en plein écran sur l'écran de projection, sans
  l'interface de YouTube. Le son sort de l'ordinateur.
- **Publicités** : bloquées par le moteur Ghostery avec les listes uBlock Origin et
  EasyList (y compris les règles spéciales YouTube), mises à jour une fois par jour.
  Si une publicité passe malgré tout, elle est coupée et passée automatiquement.
- La **télécommande** (lecture/pause, ±10 s, position, volume) apparaît à droite
  pendant la diffusion, avec l'aperçu de ce qui est affiché sur l'écran de projection.

## Installation et mise à jour

Prérequis : [Git](https://git-scm.com) et [Node.js](https://nodejs.org).

Placez `mettre_a_jour.bat` (Windows) ou `mettre_a_jour.command` (Mac) dans un
dossier, puis lancez-le : il télécharge l'application depuis GitHub et installe
ses dépendances. Relancez-le à chaque fois que vous voulez la dernière version.

Sur Mac, au premier lancement, autorisez l'application dans
**Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran**,
puis relancez-la. L'application affiche un bouton pour ouvrir ce réglage.
