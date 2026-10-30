const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  desktopCapturer,
  screen,
  session,
  systemPreferences,
  shell,
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const fichiers = require("./fichiers");
const bureaux = require("./bureaux");
const foreground = require("./foreground");
const { createObsServer } = require("./obs/server");

const APP_TITLE = "Diffusion Écran";
const PROJECTOR_TITLE = "Diffusion Écran — Projection";
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const ICON_PATH = path.join(__dirname, "assets", "icon.png");
const FIT_MODES = ["contain", "cover", "fill"];

// Dossier de données (réglages, conversions) : nom sans accent, sinon
// Electron peut se rabattre sur un dossier partagé selon le système.
app.setPath("userData", path.join(app.getPath("appData"), "Diffusion Ecran"));

let controlWindow = null;
let projectorWindow = null;
// Ce qui est actuellement envoyé sur l'écran de projection, ou null.
// kind "capture" : une fenêtre ou un écran capturé (sourceId, fit, crop).
// kind "file" : un fichier (vidéo, son, image, PDF, présentation) lu par
// l'application elle-même (file, slide).
// kind "move" : une fenêtre placée sur l'écran de projection (Windows).
let live = null;

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
  const base = { live: false };
  if (!live) return base;
  const display = listDisplays().find((d) => d.id === live.displayId);
  return {
    ...base,
    live: true,
    kind: live.kind,
    sourceId: live.sourceId || null,
    sourceName: live.sourceName,
    file: live.file ? { path: live.file.path, type: live.file.type } : null,
    displayId: live.displayId,
    displayLabel: display ? display.label : "",
    fit: live.fit,
    otherDesktop: !!live.otherDesktop,
    // Pour l'aperçu d'un fichier : la fenêtre de projection elle-même est capturée.
    previewSourceId:
      live.kind === "file" && projectorWindow && !projectorWindow.isDestroyed()
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
  onWebmClient: (id, start, format) => {
    if (relayWindow && !relayWindow.isDestroyed()) {
      relayWindow.webContents.send("relay:recorder", { id, start, format });
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

// Son du flux : celui du fichier (lu par l'application), sinon le son de
// l'ordinateur (Windows seulement : les autres systèmes ne le permettent pas).
function relayAudioSource() {
  if (!live || !obsAudioEnabled()) return null;
  if (live.kind === "file") {
    return projectorWindow && !projectorWindow.isDestroyed() ? "file" : null;
  }
  return process.platform === "win32" ? "system" : null;
}

let pendingAudio = null;
function syncRelayAudio() {
  if (!relayWindow || relayWindow.isDestroyed()) return;
  const mode = obs.clientCount() > 0 ? relayAudioSource() : null;
  const frame = mode === "file" ? projectorWindow.webContents.mainFrame : null;
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
      const audio = pendingAudio.mode === "file" ? pendingAudio.frame : "loopback";
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
  if (live.kind === "file") {
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

// --- Fenêtre de projection -----------------------------------------------

function closeProjector() {
  if (movedHwnd) releaseMovedWindow();
  const win = projectorWindow;
  projectorWindow = null;
  live = null;
  if (win && !win.isDestroyed()) win.destroy();
}

function enterFullscreen(win, display) {
  win.setBounds(display.bounds);
  if (process.platform === "darwin") {
    win.setSimpleFullScreen(true);
  } else {
    win.setFullScreen(true);
  }
}

function openProjector(display, kind) {
  const webPreferences = {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false,
    // Une vidéo démarre avec le son sans clic sur l'écran de projection.
    autoplayPolicy: "no-user-gesture-required",
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

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    // Repositionné après l'affichage : Windows ajuste parfois les bornes
    // quand les deux écrans n'ont pas la même mise à l'échelle.
    enterFullscreen(win, display);
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

  win.loadFile(
    kind === "file"
      ? path.join(__dirname, "media", "player.html")
      : path.join(__dirname, "projector", "projector.html")
  );

  win.on("closed", () => {
    if (projectorWindow === win) {
      projectorWindow = null;
      live = null;
      broadcastStatus();
    }
  });

  return win;
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
    request.kind !== "file" &&
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

// Fichier : prêt à diffuser (présentation convertie en diapositives…).
async function startFile(request) {
  const item = fichiers.describe(String(request.path || ""));
  if (!item) return { ...status(), error: "Ce fichier est introuvable ou n'est pas pris en charge." };
  let slides = null;
  try {
    slides = await fichiers.prepare(item, app.getPath("userData"));
  } catch (error) {
    return { ...status(), error: error.message };
  }
  return startProjection({ ...request, kind: "file", file: { ...item, slides } });
}

function startProjection(request) {
  if (movedHwnd) {
    releaseMovedWindow();
    live = null;
  }
  const kind = request.kind === "file" ? "file" : "capture";
  const display = findDisplay(request.displayId) || findDisplay(defaultDisplayId());
  const reuse =
    projectorWindow &&
    !projectorWindow.isDestroyed() &&
    live &&
    live.displayId === display.id &&
    live.kind === kind;

  if (kind === "file") {
    live = {
      kind,
      file: request.file,
      sourceName: request.file.name,
      displayId: display.id,
      fit: FIT_MODES.includes(request.fit) ? request.fit : "contain",
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
      old.destroy();
    }
    projectorWindow = openProjector(display, kind);
  }
  if (reuse) {
    // Changement à chaud, sans fermer l'écran de projection.
    projectorWindow.webContents.send("projector:source", live);
  }
  broadcastStatus();
  return status();
}

function updateCapture(patch) {
  if (live && live.kind !== "move" && projectorWindow && !projectorWindow.isDestroyed()) {
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

ipcMain.handle("projection:start", (_event, request) => {
  if (request.kind === "file") return startFile(request);
  return shouldPlaceWindow(request) ? startWindowPlacement(request) : startProjection(request);
});

// --- Fichiers --------------------------------------------------------------------

function savedFiles() {
  const list = loadSettings().files;
  return Array.isArray(list) ? list : [];
}

ipcMain.handle("files:list", () => savedFiles().map(fichiers.describe).filter(Boolean));

ipcMain.handle("files:save", (_event, paths) => {
  saveSettings({ files: (Array.isArray(paths) ? paths : []).map(String) });
});

ipcMain.handle("files:pick", async () => {
  const result = await dialog.showOpenDialog(controlWindow, {
    title: "Ajouter des fichiers à diffuser",
    properties: ["openFile", "multiSelections"],
    filters: fichiers.DIALOG_FILTERS,
  });
  return result.canceled ? [] : result.filePaths.map(fichiers.describe).filter(Boolean);
});

ipcMain.handle("files:describe", (_event, paths) =>
  (Array.isArray(paths) ? paths : []).map((p) => fichiers.describe(String(p))).filter(Boolean)
);

// Conversion à l'avance (dès qu'une présentation est choisie dans la liste).
ipcMain.handle("files:prepare", async (_event, file) => {
  const item = fichiers.describe(String(file || ""));
  if (!item) return { ok: false, error: "Fichier introuvable." };
  try {
    const slides = await fichiers.prepare(item, app.getPath("userData"));
    return { ok: true, slides: slides ? { kind: slides.kind } : null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Le PDF des diapositives, lu uniquement pour le fichier en cours de diffusion.
ipcMain.handle("files:read-slides-pdf", (event) => {
  if (!projectorWindow || event.sender !== projectorWindow.webContents) return null;
  const pdf = live && live.file && live.file.slides && live.file.slides.pdf;
  return pdf ? fs.promises.readFile(pdf) : null;
});

// Télécommande : régie → écran de projection, et état en retour.
ipcMain.handle("media:command", (_event, command) => {
  if (live && live.kind === "file" && projectorWindow && !projectorWindow.isDestroyed()) {
    projectorWindow.webContents.send("media:command", command);
  }
});

ipcMain.on("media:state", (event, state) => {
  if (projectorWindow && event.sender === projectorWindow.webContents) sendToControl("media-state", state);
});

ipcMain.on("media:error", (event, message) => {
  if (!projectorWindow || event.sender !== projectorWindow.webContents) return;
  sendToControl("notice", `Impossible de lire ce fichier : ${message}`);
});

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
