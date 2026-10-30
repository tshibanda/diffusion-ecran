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
  temps de la diffusion, puis retrouve son bureau à l'arrêt.
- Si vous tracez une zone sur l'aperçu, la fenêtre reste à sa place et seule la zone
  est copiée sur l'écran de projection : la fenêtre doit alors rester visible sur le
  bureau affiché (Windows ne dessine pas les fenêtres des autres bureaux).

### Bureaux virtuels de Windows (Windows + Tab)

- Dans l'onglet **Fenêtres**, la barre **Bureaux** liste vos bureaux (avec leur nom
  s'ils en ont un). Le point orange indique le bureau affiché en ce moment.
- Cliquez sur un autre bureau pour voir ses fenêtres, puis sur une fenêtre pour la
  diffuser. Cliquer sur **Diffuser** ne fait pas changer de bureau.

### Diffuser des fichiers (vidéo, son, image, PDF, PowerPoint)

- Onglet **Fichiers** : **+ Ajouter des fichiers** (ou glissez-les dans la liste). La
  liste est gardée d'une fois sur l'autre ; **✕** retire un fichier de la liste sans le
  supprimer de l'ordinateur.
- Cliquez sur un fichier pour le prévisualiser, puis **▶ Diffuser** (ou double-clic) :
  il s'affiche en plein écran sur l'écran de projection, lu par l'application elle-même.
- **Vidéos et sons** (MP4, MOV, WebM, MKV, MP3, WAV…) : télécommande à droite (lecture /
  pause, ±10 s, position, volume, lecture en boucle) ; la touche Espace met en pause.
- **Images** (JPG, PNG, GIF, WebP…).
- **PDF et présentations** (PowerPoint .pptx/.ppt, LibreOffice .odp) : affichés
  diapositive par diapositive, nets à la taille de l'écran. **◀ Précédent / Suivant ▶**
  dans la régie, ou les flèches ← → et Espace du clavier.
- Les présentations sont converties en images une seule fois (dès qu'elles sont choisies
  dans la liste) avec **PowerPoint** s'il est installé, sinon **LibreOffice** (gratuit).
  Les diapositives masquées sont ignorées. Les animations à l'intérieur d'une diapositive
  et les vidéos intégrées ne sont pas reprises : pour une vidéo, ajoutez-la à part.

## Flux vidéo (avec le son) pour OBS Studio

Pendant la diffusion, l'application publie le rendu, image et son, sur cet ordinateur.
L'encadré **OBS Studio** de la régie affiche les adresses (bouton **Copier**) et indique
quand OBS est connecté.

- **Source navigateur** (recommandé) : dans OBS, **+** → **Navigateur**, adresse
  `http://127.0.0.1:8765/`, largeur **1920**, hauteur **1080**, et cochez **« Contrôler
  l'audio via OBS »** : le son arrive dans la table de mixage d'OBS. Chaque image est
  envoyée encodée puis affichée dès son arrivée (WebCodecs), avec environ 0,15 s de
  retard. La page se recharge toute seule quand l'application redémarre ou est mise à
  jour : inutile de « Rafraîchir le cache de la page » dans OBS.
- ou **Source média** : **+** → **Source média**, décochez **Fichier local**, entrée
  `http://127.0.0.1:8765/live.mp4` (environ 1 s de retard).
- Pour profiter des 60 images par seconde : dans OBS, **Paramètres → Vidéo → Valeur
  FPS commune : 60** (et, pour la Source navigateur, laissez la fréquence d'images
  d'OBS ou réglez une fréquence personnalisée de 60).
- `http://127.0.0.1:8765/flux.mjpg` reste disponible pour une image seule, sans son.

**Le son du flux** (jamais celui des autres fenêtres) :
- fichier (onglet Fichiers) : uniquement le son du fichier ;
- fenêtre, sous Windows : uniquement le son de l'application de cette fenêtre (par
  exemple Chrome, ses onglets compris), capté par l'API Windows « process loopback »
  (Windows 10 version 2004 ou plus récent). Si Windows refuse, le flux reste sans son et
  l'encadré OBS l'indique : il ne bascule jamais sur le son de tout l'ordinateur ;
- écran entier, sous Windows : le son de l'ordinateur (un écran n'est pas une seule
  fenêtre) ;
- sur Mac : seul le son des fichiers peut être inclus.
- La case **Inclure le son** permet de le couper.
- Important : cochez « Contrôler l'audio via OBS » dans la Source navigateur. Sinon la
  page joue le son sur les haut-parleurs, qui serait capturé à nouveau (écho).

**Qualité :** 60 images par seconde, en 1080p (par défaut, 20 Mbit/s) ou 720p (plus
léger pour un ordinateur modeste). La vidéo est encodée en H.264, par la carte graphique
quand elle le permet ; une zone recadrée est capturée en plus haute définition pour
rester nette. Si l'ordinateur ne suit pas, des images sont sautées plutôt que de prendre
du retard : passez alors en 720p. Le flux a environ une seconde de retard. Sans
diffusion, il est noir. Rien n'est calculé tant qu'OBS n'est pas connecté. Si le port
8765 est déjà pris, l'application en choisit un autre (8766, 8767…) et l'affiche dans
l'encadré.

## Installation et mise à jour

Prérequis : [Git](https://git-scm.com) et [Node.js](https://nodejs.org).

Placez `mettre_a_jour.bat` (Windows) ou `mettre_a_jour.command` (Mac) dans un
dossier, puis lancez-le : il télécharge l'application depuis GitHub et installe
ses dépendances. Relancez-le à chaque fois que vous voulez la dernière version.

Sur Mac, au premier lancement, autorisez l'application dans
**Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran**,
puis relancez-la. L'application affiche un bouton pour ouvrir ce réglage.
