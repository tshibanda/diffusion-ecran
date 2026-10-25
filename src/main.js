const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  desktopCapturer,
  screen,
  session,
  net,
  systemPreferences,
  shell,
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");
const { parseYoutubeUrl, PAGE_SCRIPT } = require("./youtube");
const bureaux = require("./bureaux");
const foreground = require("./foreground");
const { createObsServer } = require("./obs/server");

const APP_TITLE = "Diffusion Écran";
const PROJECTOR_TITLE = "Diffusion Écran — Projection";
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const ICON_PATH = path.join(__dirname, "assets", "icon.png");
const FIT_MODES = ["contain", "cover", "fill"];
const YOUTUBE_PARTITION = "persist:youtube";
const YOUTUBE_TICK_MS = 400;
const BLOCKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Dossier de données (réglages, cache du bloqueur) : nom sans accent, sinon
// Electron peut se rabattre sur un dossier partagé selon le système.
app.setPath("userData", path.join(app.getPath("appData"), "Diffusion Ecran"));

let controlWindow = null;
let projectorWindow = null;
let youtubeTicker = null;
// Ce qui est actuellement envoyé sur l'écran de projection, ou null.
// kind "capture" : une fenêtre ou un écran capturé (sourceId, fit, crop).
// kind "youtube" : une vidéo YouTube ouverte directement (watchUrl).
let live = null;
// "loading" | "on" | "off"
let adblockStatus = "loading";

// --- Réglages (écran cible, cadrage) -------------------------------------
// Stockés dans le dossier de données de l'application, jamais dans le
// dossier du projet : une mise à jour via git ne les touche pas.

function settingsPath() {
  return path.join(app.getPath("userData"), "reglages.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch {
    // Pas bloquant : on retombera sur les valeurs par défaut.
  }
}

// --- Écrans ----------------------------------------------------------------

function controlDisplayId() {
  return controlWindow && !controlWindow.isDestroyed()
    ? screen.getDisplayMatching(controlWindow.getBounds()).id
    : screen.getPrimaryDisplay().id;
}

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  const controlId = controlDisplayId();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Écran ${i + 1}`,
    index: i + 1,
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
    primary: d.id === primaryId,
    hasControl: d.id === controlId,
  }));
}

// Écran choisi par défaut : le dernier utilisé s'il est toujours branché,
// sinon le premier écran qui n'est pas l'écran principal.
function defaultDisplayId() {
  const displays = screen.getAllDisplays();
  const saved = loadSettings().displayId;
  if (displays.some((d) => d.id === saved)) return saved;
  const primaryId = screen.getPrimaryDisplay().id;
  const secondary = displays.find((d) => d.id !== primaryId);
  return (secondary || displays[0]).id;
}

function findDisplay(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || null;
}

// --- Statut envoyé à la fenêtre de contrôle -------------------------------

function status() {
  const base = { live: false, adblock: adblockStatus };
  if (!live) return base;
  const display = listDisplays().find((d) => d.id === live.displayId);
  return {
    ...base,
    live: true,
    kind: live.kind,
    sourceId: live.sourceId || null,
    sourceName: live.sourceName,
    watchUrl: live.watchUrl || null,
    displayId: live.displayId,
    displayLabel: display ? display.label : "",
    fit: live.fit,
    otherDesktop: !!live.otherDesktop,
    // Pour l'aperçu YouTube : la fenêtre de projection elle-même est capturée.
    previewSourceId:
      live.kind === "youtube" && projectorWindow && !projectorWindow.isDestroyed()
        ? projectorWindow.getMediaSourceId()
        : null,
  };
}

function sendToControl(channel, payload) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(channel, payload);
  }
}

function broadcastStatus() {
  sendToControl("status", status());
  pushBrowseState();
  syncRelaySource();
}

// --- Flux pour OBS Studio ------------------------------------------------------
// Une fenêtre cachée (obs/relay) compose ce qui est diffusé en 1920×1080 :
// images JPEG (flux MJPEG) et enregistrement image + son (flux WebM), servis
// par obs/server.js. Rien n'est calculé tant qu'OBS n'est pas connecté.

let relayWindow = null;
let relaySourceKey = null;
let relayAudioKey = null;
const obs = createObsServer({
  onClientsChanged: (counts) => {
    if (relayWindow && !relayWindow.isDestroyed()) relayWindow.webContents.send("relay:clients", counts);
    syncRelayAudio();
    sendToControl("obs", obsInfo());
  },
  onWebmClient: (id, start) => {
    if (relayWindow && !relayWindow.isDestroyed()) {
      relayWindow.webContents.send("relay:recorder", { id, start });
    }
  },
});

function obsAudioEnabled() {
  return loadSettings().obsAudio !== false;
}

function obsQuality() {
  return loadSettings().obsQuality === 720 ? 720 : 1080;
}

function obsInfo() {
  return {
    urls: obs.urls(),
    clients: obs.clientCount(),
    audio: obsAudioEnabled(),
    audioSource: relayAudioSource(),
    quality: obsQuality(),
  };
}

// Son du flux : celui de la vidéo YouTube (lue par l'application), sinon le
// son de l'ordinateur (Windows seulement : les autres systèmes ne le permettent pas).
function relayAudioSource() {
  if (!live || !obsAudioEnabled()) return null;
  if (live.kind === "youtube") {
    return projectorWindow && !projectorWindow.isDestroyed() ? "youtube" : null;
  }
  return process.platform === "win32" ? "system" : null;
}

let pendingAudio = null;
function syncRelayAudio() {
  if (!relayWindow || relayWindow.isDestroyed()) return;
  const mode = obs.clientCount() > 0 ? relayAudioSource() : null;
  const frame = mode === "youtube" ? projectorWindow.webContents.mainFrame : null;
  const key = `${mode}:${frame ? frame.processId + "/" + frame.routingId : ""}`;
  if (key === relayAudioKey) return;
  relayAudioKey = key;
  pendingAudio = mode ? { mode, frame } : null;
  // getDisplayMedia demande un « geste utilisateur » : d'où le second argument.
  relayWindow.webContents
    .executeJavaScript(`window.__relayAudio && window.__relayAudio(${!!mode})`, true)
    .catch(() => {});
  sendToControl("obs", obsInfo());
}

// Seule la fenêtre du flux OBS demande une capture : on lui fournit le son
// choisi ci-dessus (l'image fournie avec est ignorée).
function handleDisplayMediaRequests() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const relayFrame = relayWindow && !relayWindow.isDestroyed() ? relayWindow.webContents.mainFrame : null;
    const fromRelay =
      relayFrame &&
      request.frame &&
      request.frame.processId === relayFrame.processId &&
      request.frame.routingId === relayFrame.routingId;
    if (!fromRelay || !pendingAudio) return callback({});
    try {
      const [screenSource] = await desktopCapturer.getSources({ types: ["screen"] });
      const audio = pendingAudio.mode === "youtube" ? pendingAudio.frame : "loopback";
      callback({ video: screenSource, audio });
    } catch {
      callback({});
    }
  });
}

ipcMain.handle("settings:obs-quality", (_event, height) => {
  saveSettings({ obsQuality: height === 720 ? 720 : 1080 });
  if (relayWindow && !relayWindow.isDestroyed()) relayWindow.webContents.send("relay:quality", obsQuality());
  obs.dropWebmClients();
  return obsInfo();
});

ipcMain.handle("settings:obs-audio", (_event, value) => {
  saveSettings({ obsAudio: !!value });
  syncRelayAudio();
  return obsInfo();
});

// Ce que le flux doit montrer : la même chose que l'écran de projection.
function relaySource() {
  if (!live) return null;
  if (live.kind === "youtube") {
    return projectorWindow && !projectorWindow.isDestroyed()
      ? { sourceId: projectorWindow.getMediaSourceId(), fit: "contain", crop: null }
      : null;
  }
  if (live.kind === "move") return { sourceId: live.sourceId, fit: "contain", crop: null };
  return { sourceId: live.sourceId, fit: live.fit, crop: live.crop || null };
}

function syncRelaySource() {
  if (!relayWindow || relayWindow.isDestroyed()) return;
  const next = relaySource();
  const key = JSON.stringify(next);
  if (key === relaySourceKey) return;
  relaySourceKey = key;
  relayWindow.webContents.send("relay:source", next);
  syncRelayAudio();
}

function createRelayWindow() {
  relayWindow = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  relayWindow.webContents.on("did-finish-load", () => {
    relaySourceKey = null;
    relayAudioKey = null;
    syncRelaySource();
    syncRelayAudio();
    relayWindow.webContents.send("relay:quality", obsQuality());
    relayWindow.webContents.send("relay:clients", obs.counts());
  });
  relayWindow.loadFile(path.join(__dirname, "obs", "relay.html"));
}

ipcMain.on("relay:frame", (event, frame) => {
  if (relayWindow && event.sender === relayWindow.webContents) obs.pushFrame(Buffer.from(frame));
});

ipcMain.on("relay:chunk", (event, id, chunk) => {
  if (relayWindow && event.sender === relayWindow.webContents) obs.pushChunk(id, Buffer.from(chunk));
});

ipcMain.handle("obs:info", () => obsInfo());

ipcMain.handle("clipboard:write", (_event, text) => clipboard.writeText(String(text)));

// --- Bloqueur de publicités (fenêtre YouTube) ----------------------------
// Moteur Ghostery chargé avec les listes uBlock Origin + EasyList (pubs,
// pisteurs, bandeaux cookies), y compris les scripts anti-pub YouTube.
// Les listes sont gardées en cache et rafraîchies une fois par jour.

function blockerCachePath() {
  return path.join(app.getPath("userData"), "bloqueur-pub.bin");
}

async function loadBlocker() {
  const cache = blockerCachePath();
  let cached = null;
  try {
    const stat = fs.statSync(cache);
    cached = { fresh: Date.now() - stat.mtimeMs < BLOCKER_MAX_AGE_MS };
  } catch {
    // Pas encore de cache.
  }
  const fromCache = async () => ElectronBlocker.deserialize(await fs.promises.readFile(cache));

  if (cached && cached.fresh) {
    try {
      return await fromCache();
    } catch {
      // Cache illisible (version différente…) : on retélécharge.
    }
  }
  try {
    const blocker = await ElectronBlocker.fromPrebuiltFull((url, init) => net.fetch(url, init));
    fs.promises.writeFile(cache, blocker.serialize()).catch(() => {});
    return blocker;
  } catch (error) {
    // Hors ligne : on garde les listes de la veille plutôt que rien.
    if (cached) return fromCache();
    throw error;
  }
}

function cleanUserAgent(ua) {
  // YouTube sert une page dégradée aux navigateurs qu'il ne reconnaît pas :
  // on ne garde que les mentions d'un Chrome ordinaire (sans « Electron/… »
  // ni le nom de l'application).
  return ua.replace(/ (?!(?:Mozilla|AppleWebKit|Chrome|Safari)\/)[^\s()]+\/[^\s()]+/g, "");
}

let youtubeSessionPromise = null;
function youtubeSession() {
  if (!youtubeSessionPromise) youtubeSessionPromise = setupYoutubeSession();
  return youtubeSessionPromise;
}

async function setupYoutubeSession() {
  const ses = session.fromPartition(YOUTUBE_PARTITION);
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === "fullscreen")
  );
  // Refus des cookies non essentiels : évite la page de consentement (UE).
  const expirationDate = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  for (const domain of [".youtube.com", ".google.com"]) {
    await ses.cookies
      .set({
        url: `https://www${domain}`,
        domain,
        name: "SOCS",
        value: "CAI",
        path: "/",
        secure: true,
        sameSite: "lax",
        expirationDate,
      })
      .catch(() => {});
  }
  try {
    const blocker = await loadBlocker();
    blocker.enableBlockingInSession(ses);
    adblockStatus = "on";
  } catch {
    adblockStatus = "off";
  }
  broadcastStatus();
  return ses;
}

// --- Fenêtre de projection -----------------------------------------------

function stopYoutubeTicker() {
  clearInterval(youtubeTicker);
  youtubeTicker = null;
}

function closeProjector() {
  if (movedHwnd) releaseMovedWindow();
  const win = projectorWindow;
  projectorWindow = null;
  live = null;
  stopYoutubeTicker();
  if (win && !win.isDestroyed()) win.destroy();
}

function enterFullscreen(win, display, kind) {
  win.setBounds(display.bounds);
  // Sur Mac, la vidéo YouTube passe elle-même en plein écran : la fenêtre
  // doit donc être en plein écran « natif » pour que les deux s'accordent.
  if (process.platform === "darwin" && kind === "capture") {
    win.setSimpleFullScreen(true);
  } else {
    win.setFullScreen(true);
  }
}

function openProjector(display, kind) {
  const webPreferences =
    kind === "youtube"
      ? {
          partition: YOUTUBE_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          autoplayPolicy: "no-user-gesture-required",
          backgroundThrottling: false,
        }
      : {
          preload: PRELOAD_PATH,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        };
  const win = new BrowserWindow({
    ...display.bounds,
    title: PROJECTOR_TITLE,
    icon: ICON_PATH,
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences,
  });
  win.setMenu(null);
  // Garde son titre (la page YouTube voudrait mettre le sien).
  win.on("page-title-updated", (event) => event.preventDefault());

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    // Repositionné après l'affichage : Windows ajuste parfois les bornes
    // quand les deux écrans n'ont pas la même mise à l'échelle.
    enterFullscreen(win, display, kind);
    // Toujours au premier plan, sauf si on projette sur l'écran de la régie
    // (sinon la fenêtre de contrôle deviendrait inaccessible).
    if (controlDisplayId() !== display.id) win.setAlwaysOnTop(true, "screen-saver");
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.focus();
    broadcastStatus();
  });

  // Échap sur l'écran de projection : arrêt de la diffusion.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      if (projectorWindow === win) {
        closeProjector();
        broadcastStatus();
      }
    }
  });

  if (kind === "youtube") {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Si la vidéo quitte son plein écran, la fenêtre doit rester plein écran.
    win.on("leave-full-screen", () => {
      setTimeout(() => {
        if (projectorWindow === win && !win.isDestroyed()) enterFullscreen(win, display, kind);
      }, 200);
    });
  } else {
    win.loadFile(path.join(__dirname, "projector", "projector.html"));
  }

  win.on("closed", () => {
    if (projectorWindow === win) {
      projectorWindow = null;
      live = null;
      stopYoutubeTicker();
      broadcastStatus();
    }
  });

  return win;
}

async function loadYoutube(win, watchUrl) {
  await youtubeSession();
  if (win.isDestroyed()) return;
  stopYoutubeTicker();
  win.loadURL(watchUrl).catch(() => {});
  const code = `${PAGE_SCRIPT}\nwindow.__diffusion && window.__diffusion.tick();`;
  youtubeTicker = setInterval(() => {
    if (win.isDestroyed()) return stopYoutubeTicker();
    // userGesture = true : c'est ce qui autorise le plein écran du lecteur.
    win.webContents.executeJavaScript(code, true).catch(() => {});
  }, YOUTUBE_TICK_MS);
}

// --- Diffusion d'une fenêtre par placement (Windows) ------------------------
// Une fenêtre d'un autre bureau n'est pas dessinée par Windows : sa capture
// reste figée (vidéo noire). On place donc la fenêtre elle-même en plein écran
// sur l'écran de projection (visible depuis le bureau affiché) ; à l'arrêt, elle
// retrouve exactement sa place, son état et son bureau d'origine.
const ALIVE_CHECK_MS = 2000;
let movedHwnd = null;
let aliveTimer = null;
let pendingRestores = 0;

function windowHwnd(sourceId) {
  const m = /^window:(\d+):/.exec(sourceId || "");
  return m ? m[1] : null;
}

function shouldPlaceWindow(request) {
  return (
    bureaux.supported &&
    request.kind !== "youtube" &&
    !request.crop &&
    !!windowHwnd(request.sourceId)
  );
}

function releaseMovedWindow() {
  clearInterval(aliveTimer);
  aliveTimer = null;
  const hwnd = movedHwnd;
  movedHwnd = null;
  if (!hwnd) return Promise.resolve();
  pendingRestores++;
  return bureaux.restore(hwnd).finally(() => pendingRestores--);
}

// Attend que les fenêtres déplacées aient retrouvé leur place.
async function waitForRestores() {
  if (movedHwnd) await releaseMovedWindow();
  while (pendingRestores > 0) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function startWindowPlacement(request) {
  const hwnd = windowHwnd(request.sourceId);
  const display = findDisplay(request.displayId) || findDisplay(defaultDisplayId());
  if (projectorWindow) closeProjector();
  if (movedHwnd && movedHwnd !== hwnd) await releaseMovedWindow();

  // Coordonnées en vrais pixels (l'écran peut être mis à l'échelle, ex. 125 %).
  const b = display.bounds;
  const rect = screen.dipToScreenRect
    ? screen.dipToScreenRect(null, b)
    : {
        x: Math.round(b.x * display.scaleFactor),
        y: Math.round(b.y * display.scaleFactor),
        width: Math.round(b.width * display.scaleFactor),
        height: Math.round(b.height * display.scaleFactor),
      };
  const result = await bureaux.place(hwnd, {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
  if (!result.ok) {
    return { ...status(), error: result.error || "Impossible de placer cette fenêtre." };
  }
  movedHwnd = hwnd;
  live = {
    kind: "move",
    sourceId: request.sourceId,
    sourceName: request.sourceName,
    displayId: display.id,
    // Fenêtre d'un autre bureau, affichée sur le bureau actuel le temps de la diffusion.
    otherDesktop: !!result.otherDesktop,
  };
  saveSettings({ displayId: display.id });

  clearInterval(aliveTimer);
  aliveTimer = setInterval(async () => {
    const check = await bureaux.alive(hwnd);
    if (check.ok && !check.alive && movedHwnd === hwnd) {
      clearInterval(aliveTimer);
      movedHwnd = null;
      live = null;
      broadcastStatus();
      sendToControl("notice", "La fenêtre diffusée a été fermée. Diffusion arrêtée.");
    }
  }, ALIVE_CHECK_MS);

  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.focus();
  broadcastStatus();
  return status();
}

function startProjection(request) {
  if (movedHwnd) {
    releaseMovedWindow();
    live = null;
  }
  const kind = request.kind === "youtube" ? "youtube" : "capture";
  const display = findDisplay(request.displayId) || findDisplay(defaultDisplayId());
  const reuse =
    projectorWindow &&
    !projectorWindow.isDestroyed() &&
    live &&
    live.displayId === display.id &&
    live.kind === kind;

  if (kind === "youtube") {
    const info = parseYoutubeUrl(request.url);
    if (!info) return { ...status(), error: "Lien YouTube non reconnu." };
    live = {
      kind,
      watchUrl: info.watchUrl,
      sourceName: request.title || "Vidéo YouTube",
      displayId: display.id,
    };
  } else {
    live = {
      kind,
      sourceId: request.sourceId,
      sourceName: request.sourceName,
      displayId: display.id,
      fit: FIT_MODES.includes(request.fit) ? request.fit : "contain",
      crop: request.crop || null,
    };
    saveSettings({ fit: live.fit });
  }
  saveSettings({ displayId: display.id });

  if (!reuse) {
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      const old = projectorWindow;
      projectorWindow = null;
      stopYoutubeTicker();
      old.destroy();
    }
    projectorWindow = openProjector(display, kind);
  }
  if (kind === "youtube") {
    loadYoutube(projectorWindow, live.watchUrl);
  } else if (reuse) {
    // Changement de fenêtre à chaud, sans fermer l'écran de projection.
    projectorWindow.webContents.send("projector:source", live);
  }
  broadcastStatus();
  return status();
}

function updateCapture(patch) {
  if (live && live.kind === "capture" && projectorWindow && !projectorWindow.isDestroyed()) {
    Object.assign(live, patch);
    projectorWindow.webContents.send("projector:source", live);
  }
  broadcastStatus();
  return status();
}

// Identifiants de capture de nos propres fenêtres, pour ne pas les proposer.
function ownSourceIds() {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .map((w) => w.getMediaSourceId());
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle("sources:list", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  });
  const own = new Set(ownSourceIds());
  const ownTitles = new Set([APP_TITLE, PROJECTOR_TITLE]);
  const displays = listDisplays();
  return sources
    .filter((s) => s.name && !own.has(s.id) && !ownTitles.has(s.name))
    .map((s) => {
      const kind = s.id.startsWith("screen:") ? "screen" : "window";
      let name = s.name;
      if (kind === "screen") {
        const d = displays.find((x) => String(x.id) === s.display_id);
        if (d) name = `${d.label}${d.primary ? " (principal)" : ""}`;
      }
      return {
        id: s.id,
        name,
        kind,
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      };
    });
});

ipcMain.handle("displays:list", () => listDisplays());

ipcMain.handle("settings:get", () => {
  const saved = loadSettings();
  return {
    displayId: defaultDisplayId(),
    fit: FIT_MODES.includes(saved.fit) ? saved.fit : "contain",
  };
});

// --- Parcourir YouTube --------------------------------------------------------
// Navigateur YouTube intégré (même session que l'écran de projection : bloqueur
// de publicités, cookies). On y choisit la vidéo, puis « Diffuser cette vidéo »
// l'ouvre en plein écran sur l'écran de projection, au même moment.
//
// Pourquoi pas simplement capturer la fenêtre de Chrome : Windows ne dessine
// pas les fenêtres d'un bureau virtuel non affiché, et Chrome arrête de dessiner
// une fenêtre cachée ; la capture n'en reçoit qu'une image figée et noire.
// Ici, c'est l'application qui lit la vidéo : elle s'affiche toujours.

const BROWSE_TOOLBAR_HEIGHT = 50;
const BROWSE_ADS_TICK_MS = 500;
const YOUTUBE_HOME = "https://www.youtube.com/";
let browse = null; // { win, toolbar, content }

function browseState() {
  if (!browse) return null;
  const wc = browse.content.webContents;
  const url = wc.getURL();
  return {
    url,
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isVideo: !!parseYoutubeUrl(url),
    live: !!live,
    liveName: live ? live.sourceName : "",
  };
}

function pushBrowseState() {
  if (browse && !browse.toolbar.webContents.isDestroyed()) {
    browse.toolbar.webContents.send("browse:state", browseState());
  }
}

async function openBrowseWindow(startUrl) {
  if (browse) {
    browse.win.show();
    browse.win.focus();
    if (startUrl) browse.content.webContents.loadURL(startUrl).catch(() => {});
    return;
  }
  await youtubeSession();
  const area = screen.getDisplayMatching(
    controlWindow && !controlWindow.isDestroyed()
      ? controlWindow.getBounds()
      : screen.getPrimaryDisplay().bounds
  ).workArea;
  const width = Math.min(1280, area.width - 60);
  const height = Math.min(860, area.height - 60);
  const win = new BaseWindow({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
    minWidth: 700,
    minHeight: 450,
    title: "Diffusion Écran — Parcourir YouTube",
    icon: ICON_PATH,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
  });
  const toolbar = new WebContentsView({
    webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false },
  });
  const content = new WebContentsView({
    webPreferences: {
      partition: YOUTUBE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(content);
  win.contentView.addChildView(toolbar);
  const layout = () => {
    const { width: w, height: h } = win.getContentBounds();
    toolbar.setBounds({ x: 0, y: 0, width: w, height: BROWSE_TOOLBAR_HEIGHT });
    content.setBounds({ x: 0, y: BROWSE_TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - BROWSE_TOOLBAR_HEIGHT) });
  };
  layout();
  win.on("resize", layout);

  browse = { win, toolbar, content };
  const wc = content.webContents;
  // Les liens qui voudraient ouvrir une nouvelle fenêtre s'ouvrent ici.
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-finish-load"]) {
    wc.on(event, pushBrowseState);
  }
  toolbar.webContents.on("did-finish-load", pushBrowseState);
  toolbar.webContents.loadFile(path.join(__dirname, "browse", "toolbar.html"));
  wc.loadURL(startUrl || YOUTUBE_HOME).catch(() => {});
  // Publicités qui passeraient malgré le bloqueur : coupées et passées.
  const adsCode = `${PAGE_SCRIPT}\nwindow.__diffusion && window.__diffusion.adsOnly();`;
  const adsTicker = setInterval(() => {
    if (!wc.isDestroyed()) wc.executeJavaScript(adsCode).catch(() => {});
  }, BROWSE_ADS_TICK_MS);

  win.on("closed", () => {
    clearInterval(adsTicker);
    browse = null;
    if (!wc.isDestroyed()) wc.close();
    if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
  });
}

// Envoie la vidéo affichée dans « Parcourir YouTube » vers la projection, au
// moment où elle en est, et met en pause celle de la fenêtre de navigation.
async function diffuseBrowsedVideo() {
  if (!browse) return status();
  const wc = browse.content.webContents;
  const info = parseYoutubeUrl(wc.getURL());
  if (!info) return status();
  let time = 0;
  try {
    time = await wc.executeJavaScript(`(() => {
      const v = document.querySelector("#movie_player video");
      if (!v) return 0;
      v.pause();
      return v.currentTime || 0;
    })()`);
  } catch {
    // Pas de lecteur : on part du début.
  }
  const list = new URL(info.watchUrl).searchParams.get("list");
  let url = `https://www.youtube.com/watch?v=${info.videoId}`;
  if (list) url += `&list=${encodeURIComponent(list)}`;
  if (time > 2) url += `&t=${Math.floor(time)}s`;
  return startProjection({
    kind: "youtube",
    url,
    title: wc.getTitle().replace(/ - YouTube$/, "").replace(/^\(\d+\) /, ""),
    displayId: defaultDisplayId(),
  });
}

ipcMain.handle("browse:open", (_event, url) => openBrowseWindow(url || null));

ipcMain.handle("browse:nav", (_event, action) => {
  if (!browse) return;
  const wc = browse.content.webContents;
  if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === "reload") wc.reload();
  else if (action === "home") wc.loadURL(YOUTUBE_HOME).catch(() => {});
});

ipcMain.handle("browse:diffuse", () => diffuseBrowsedVideo());

// Voir foreground.js : empêche le changement de bureau au début d'une capture.
ipcMain.handle("foreground:hold", (_event, on) => (on ? foreground.hold() : foreground.unhold()));

// Bureaux virtuels (Windows) : lecture seule. L'application ne touche jamais
// aux fenêtres des autres applications ni aux bureaux ; l'écran de projection
// reste sur le bureau où l'application est ouverte.
ipcMain.handle("bureaux:list", async () => {
  if (!bureaux.supported) return { available: false };
  const result = await bureaux.list();
  if (!result.ok) return { available: false, error: result.error };
  return { available: true, ...result };
});

ipcMain.handle("status:get", () => status());

ipcMain.handle("projection:start", (_event, request) =>
  shouldPlaceWindow(request) ? startWindowPlacement(request) : startProjection(request)
);

ipcMain.handle("projection:stop", () => {
  closeProjector();
  broadcastStatus();
  return status();
});

ipcMain.handle("projection:fit", (_event, fit) => {
  if (!FIT_MODES.includes(fit)) return status();
  saveSettings({ fit });
  return updateCapture({ fit });
});

ipcMain.handle("projection:crop", (_event, { sourceId, crop }) => {
  if (!live || live.sourceId !== sourceId) return status();
  return updateCapture({ crop: crop || null });
});

ipcMain.handle("youtube:info", async (_event, url) => {
  const info = parseYoutubeUrl(url);
  if (!info) return { ok: false };
  let title = null;
  let author = null;
  try {
    const res = await net.fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(info.watchUrl)}`
    );
    if (res.ok) {
      const data = await res.json();
      title = data.title || null;
      author = data.author_name || null;
    }
  } catch {
    // Titre facultatif : hors ligne, on affiche juste la miniature.
  }
  return { ok: true, ...info, title, author };
});

ipcMain.handle("youtube:state", async () => {
  if (!live || live.kind !== "youtube" || !projectorWindow || projectorWindow.isDestroyed()) {
    return null;
  }
  let state;
  try {
    state = await projectorWindow.webContents.executeJavaScript(
      "window.__diffusion ? window.__diffusion.state() : { ready: false }"
    );
  } catch {
    return { ready: false };
  }
  // Le vrai titre de la vidéo, une fois connu (et pas celui d'une pub).
  if (live && state && state.ready && !state.ad && state.title && state.title !== live.sourceName) {
    live.sourceName = state.title;
    broadcastStatus();
  }
  return state;
});

ipcMain.handle("youtube:command", async (_event, { action, value }) => {
  if (!live || live.kind !== "youtube" || !projectorWindow || projectorWindow.isDestroyed()) return;
  const code = `window.__diffusion && window.__diffusion.command(${JSON.stringify(
    String(action)
  )}, ${JSON.stringify(Number(value) || 0)})`;
  await projectorWindow.webContents.executeJavaScript(code, true).catch(() => {});
});

ipcMain.handle("projector:current", () => live);

ipcMain.on("projector:ended", (event, reason) => {
  if (!projectorWindow || event.sender !== projectorWindow.webContents) return;
  closeProjector();
  broadcastStatus();
  sendToControl(
    "notice",
    reason === "capture-failed"
      ? "Impossible de capturer cette fenêtre. Diffusion arrêtée."
      : "La fenêtre diffusée a été fermée. Diffusion arrêtée."
  );
});

ipcMain.on("projector:stop-request", (event) => {
  if (!projectorWindow || event.sender !== projectorWindow.webContents) return;
  closeProjector();
  broadcastStatus();
});

// Autorisation « Enregistrement de l'écran » (macOS uniquement).
ipcMain.handle("permission:screen", () =>
  process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted"
);

ipcMain.handle("permission:open-settings", () => {
  if (process.platform === "darwin") {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );
  }
});

// --- Démarrage -----------------------------------------------------------

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: APP_TITLE,
    icon: ICON_PATH,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWindow.loadFile(path.join(__dirname, "control", "index.html"));
  controlWindow.on("closed", () => {
    controlWindow = null;
    closeProjector();
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!controlWindow) return;
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.focus();
  });

  app.whenReady().then(() => {
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(ICON_PATH);
    handleDisplayMediaRequests();
    createControlWindow();
    createRelayWindow();
    obs.listen().then(() => sendToControl("obs", obsInfo()));
    // Préparé dès le démarrage pour que la première vidéo démarre sans attendre.
    youtubeSession();

    const onDisplaysChanged = () => {
      if (live && !findDisplay(live.displayId)) {
        closeProjector();
        broadcastStatus();
        sendToControl("notice", "L'écran de projection a été débranché. Diffusion arrêtée.");
      }
      sendToControl("displays-changed");
    };
    screen.on("display-added", onDisplaysChanged);
    screen.on("display-removed", onDisplaysChanged);
    screen.on("display-metrics-changed", onDisplaysChanged);
  });

  app.on("window-all-closed", () => app.quit());

  // Avant de quitter : la fenêtre diffusée retrouve sa place d'origine.
  let restored = false;
  app.on("before-quit", (event) => {
    if (restored || (!movedHwnd && pendingRestores === 0)) return;
    event.preventDefault();
    restored = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([waitForRestores(), timeout]).finally(() => app.quit());
  });

  app.on("will-quit", () => {
    bureaux.stop();
    obs.close();
  });
}
