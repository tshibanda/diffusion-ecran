const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  systemPreferences,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");

const APP_TITLE = "Diffusion Écran";
const PROJECTOR_TITLE = "Diffusion Écran — Projection";
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const FIT_MODES = ["contain", "cover", "fill"];

let controlWindow = null;
let projectorWindow = null;
// Ce qui est actuellement envoyé sur l'écran de projection, ou null.
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

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  const controlDisplayId =
    controlWindow && !controlWindow.isDestroyed()
      ? screen.getDisplayMatching(controlWindow.getBounds()).id
      : primaryId;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Écran ${i + 1}`,
    index: i + 1,
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
    primary: d.id === primaryId,
    hasControl: d.id === controlDisplayId,
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
  if (!live) return { live: false };
  const display = listDisplays().find((d) => d.id === live.displayId);
  return {
    live: true,
    sourceId: live.sourceId,
    sourceName: live.sourceName,
    displayId: live.displayId,
    displayLabel: display ? display.label : "",
    fit: live.fit,
  };
}

function sendToControl(channel, payload) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(channel, payload);
  }
}

function broadcastStatus() {
  sendToControl("status", status());
}

// --- Fenêtre de projection -----------------------------------------------

function closeProjector() {
  const win = projectorWindow;
  projectorWindow = null;
  live = null;
  if (win && !win.isDestroyed()) win.destroy();
}

function openProjector(display) {
  const win = new BrowserWindow({
    ...display.bounds,
    title: PROJECTOR_TITLE,
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, "projector", "projector.html"));

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    // Repositionné après l'affichage : Windows ajuste parfois les bornes
    // quand les deux écrans n'ont pas la même mise à l'échelle.
    win.setBounds(display.bounds);
    if (process.platform === "darwin") {
      win.setSimpleFullScreen(true);
    } else {
      win.setFullScreen(true);
    }
    // Toujours au premier plan, sauf si on projette sur l'écran de la régie
    // (sinon la fenêtre de contrôle deviendrait inaccessible).
    const controlDisplay =
      controlWindow && !controlWindow.isDestroyed()
        ? screen.getDisplayMatching(controlWindow.getBounds()).id
        : null;
    if (controlDisplay !== display.id) win.setAlwaysOnTop(true, "screen-saver");
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.focus();
  });

  win.on("closed", () => {
    if (projectorWindow === win) {
      projectorWindow = null;
      live = null;
      broadcastStatus();
    }
  });

  return win;
}

function startProjection({ sourceId, sourceName, displayId, fit }) {
  const display = findDisplay(displayId) || findDisplay(defaultDisplayId());
  const safeFit = FIT_MODES.includes(fit) ? fit : "contain";
  const sameScreen =
    projectorWindow && !projectorWindow.isDestroyed() && live && live.displayId === display.id;

  live = { sourceId, sourceName, displayId: display.id, fit: safeFit };
  saveSettings({ displayId: display.id, fit: safeFit });

  if (sameScreen) {
    // Changement de fenêtre à chaud, sans fermer l'écran de projection.
    projectorWindow.webContents.send("projector:source", live);
  } else {
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      const old = projectorWindow;
      projectorWindow = null;
      old.destroy();
    }
    projectorWindow = openProjector(display);
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

ipcMain.handle("status:get", () => status());

ipcMain.handle("projection:start", (_event, request) => startProjection(request));

ipcMain.handle("projection:stop", () => {
  closeProjector();
  broadcastStatus();
  return status();
});

ipcMain.handle("projection:fit", (_event, fit) => {
  if (!FIT_MODES.includes(fit)) return status();
  saveSettings({ fit });
  if (live && projectorWindow && !projectorWindow.isDestroyed()) {
    live.fit = fit;
    projectorWindow.webContents.send("projector:source", live);
  }
  broadcastStatus();
  return status();
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
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
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
    createControlWindow();

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
}
