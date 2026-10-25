// Injecté dans la page YouTube de la fenêtre de projection (monde principal
// de la page, pour accéder à l'API du lecteur). Rôles :
//  - mettre le lecteur en plein écran et cacher tout le reste ;
//  - passer automatiquement les publicités qui échapperaient au bloqueur ;
//  - répondre à la télécommande de la fenêtre de contrôle.
(() => {
  if (window.__diffusion) return;

  const CSS = `
    * { cursor: none !important; }
    html, body { overflow: hidden !important; background: #000 !important; }
    #masthead-container, ytd-masthead, #secondary, #below, #comments,
    ytd-popup-container, tp-yt-iron-overlay-backdrop, ytd-mealbar-promo-renderer,
    ytd-enforcement-message-view-model, #player-ads, #masthead-ad,
    .video-ads, .ytp-ad-module, .ytp-ad-overlay-container, .ytp-ad-image-overlay,
    .ytp-chrome-top, .ytp-chrome-bottom, .ytp-gradient-top, .ytp-gradient-bottom,
    .ytp-pause-overlay, .ytp-ce-element, .ytp-cards-teaser, .ytp-cards-button,
    .ytp-paid-content-overlay, .ytp-watermark, .iv-branding, .ytp-bezel,
    .ytp-endscreen-content, .ytp-suggested-action, .ytp-featured-product,
    .ytp-autonav-endscreen-countdown-overlay, .ytp-chrome-controls,
    .ytp-iv-player-content, .ytp-tooltip, .ytp-contextmenu {
      display: none !important;
    }
    #movie_player {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483646 !important;
      background: #000 !important;
    }
  `;

  const player = () => document.getElementById("movie_player");
  const video = () => document.querySelector("#movie_player video");
  const call = (name, ...args) => {
    const p = player();
    return p && typeof p[name] === "function" ? p[name](...args) : undefined;
  };
  const has = (name) => {
    const p = player();
    return !!p && typeof p[name] === "function";
  };

  function addStyle() {
    if (document.getElementById("diffusion-style")) return;
    const style = document.createElement("style");
    style.id = "diffusion-style";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function isAd() {
    const p = player();
    return !!p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting"));
  }

  // Dernier rempart si une publicité passe malgré le bloqueur : on la coupe,
  // on saute à sa fin et on clique sur « Ignorer ».
  let mutedForAd = false;
  function skipAds() {
    const v = video();
    if (!v) return;
    if (isAd()) {
      if (!v.muted) {
        v.muted = true;
        mutedForAd = true;
      }
      if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.1) {
        v.currentTime = v.duration;
      }
      document
        .querySelectorAll(
          ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button"
        )
        .forEach((b) => b.click());
    } else if (mutedForAd) {
      v.muted = false;
      mutedForAd = false;
    }
    document.querySelectorAll(".ytp-ad-overlay-close-button").forEach((b) => b.click());
  }

  // Page de consentement aux cookies (UE) : on refuse, la vidéo s'ouvre ensuite.
  function handleConsent() {
    if (!location.hostname.startsWith("consent.")) return false;
    const button = document.querySelector('form[action*="consent"] button');
    if (button) button.click();
    return true;
  }

  // Les « Vous regardez toujours ? » mettent la lecture en pause.
  function dismissDialogs() {
    document
      .querySelectorAll("yt-confirm-dialog-renderer #confirm-button")
      .forEach((b) => b.click());
  }

  let observed = null;
  function watchPlayer() {
    const p = player();
    if (!p || observed === p) return;
    observed = p;
    // Réaction immédiate au début d'une publicité, sans attendre le tick.
    new MutationObserver(skipAds).observe(p, { attributes: true, attributeFilter: ["class"] });
  }

  window.__diffusion = {
    // Appelé régulièrement par l'application, avec un « geste utilisateur »
    // simulé : c'est ce qui autorise le passage en plein écran.
    tick() {
      if (handleConsent()) return;
      addStyle();
      watchPlayer();
      skipAds();
      dismissDialogs();
      const p = player();
      if (p && video() && !document.fullscreenElement && p.requestFullscreen) {
        p.requestFullscreen().catch(() => {});
      }
    },

    // Fenêtre « Parcourir YouTube » : uniquement le passage des publicités
    // (ni plein écran, ni masquage de l'interface).
    adsOnly() {
      if (handleConsent()) return;
      watchPlayer();
      skipAds();
    },

    state() {
      const v = video();
      if (!v) return { ready: false };
      const data = call("getVideoData") || {};
      return {
        ready: true,
        ad: isAd(),
        paused: v.paused,
        ended: v.ended,
        time: v.currentTime || 0,
        duration: isFinite(v.duration) ? v.duration : 0,
        muted: mutedForAd ? false : !!(has("isMuted") ? call("isMuted") : v.muted),
        volume: has("getVolume") ? call("getVolume") : Math.round(v.volume * 100),
        title: data.title || document.title.replace(/ - YouTube$/, ""),
      };
    },

    command(action, value) {
      const v = video();
      if (!v) return;
      switch (action) {
        case "toggle":
          if (v.paused) has("playVideo") ? call("playVideo") : v.play();
          else has("pauseVideo") ? call("pauseVideo") : v.pause();
          break;
        case "seek-by":
          if (has("seekTo")) call("seekTo", v.currentTime + value, true);
          else v.currentTime += value;
          break;
        case "seek-to":
          if (has("seekTo")) call("seekTo", value, true);
          else v.currentTime = value;
          break;
        case "mute":
          if (has("isMuted") ? call("isMuted") : v.muted) {
            call("unMute");
            v.muted = false;
          } else {
            call("mute");
          }
          break;
        case "volume":
          call("setVolume", value);
          if (value > 0) {
            call("unMute");
            v.muted = false;
          }
          break;
      }
    },
  };
})();
