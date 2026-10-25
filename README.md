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

### Bureaux virtuels de Windows (Windows + Tab)

- Dans l'onglet **Fenêtres**, la barre **Bureaux** liste vos bureaux (avec leur nom
  s'ils en ont un). Le point orange indique le bureau affiché en ce moment.
- Cliquez sur un autre bureau pour voir ses fenêtres, puis sur une fenêtre : elle
  se prévisualise et se diffuse directement d'ici.
- L'application ne touche à rien : elle ne change pas de bureau, ne déplace pas la
  fenêtre et ne modifie pas sa taille (une fenêtre en plein écran le reste).
- Cliquer sur **Diffuser** ne fait pas changer de bureau. L'écran de projection
  reste sur le bureau où Diffusion Écran est ouvert.
- La fenêtre ne doit pas être réduite. Si Windows ne fournit pas son image tant que
  son bureau n'est pas affiché, un message l'indique sous l'aperçu.

### Vidéo noire dans une fenêtre de navigateur

Avec l'accélération graphique, Chrome et Edge confient la vidéo directement à la carte
graphique : elle n'apparaît pas dans l'image de la fenêtre et reste noire à la
diffusion. Dans Chrome : **Paramètres → Système → désactivez « Utiliser l'accélération
graphique si elle est disponible »**, puis relancez Chrome (même réglage dans Edge).
Pour une vidéo YouTube, l'onglet **YouTube** de l'application évite ce problème.

### Diffuser une vidéo YouTube

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
