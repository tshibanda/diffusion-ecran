const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Partagé par la fenêtre de contrôle et la fenêtre de projection.
contextBridge.exposeInMainWorld("diffusion", {
  platform: process.platform,

  // Fenêtre de contrôle
  listSources: () => ipcRenderer.invoke("sources:list"),
  listDisplays: () => ipcRenderer.invoke("displays:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  start: (request) => ipcRenderer.invoke("projection:start", request),
  stop: () => ipcRenderer.invoke("projection:stop"),
  setFit: (fit) => ipcRenderer.invoke("projection:fit", fit),
  setCrop: (sourceId, crop) => ipcRenderer.invoke("projection:crop", { sourceId, crop }),
  listDesktops: () => ipcRenderer.invoke("bureaux:list"),
  holdForeground: (on) => ipcRenderer.invoke("foreground:hold", on),

  // Fichiers
  listFiles: () => ipcRenderer.invoke("files:list"),
  saveFiles: (paths) => ipcRenderer.invoke("files:save", paths),
  pickFiles: () => ipcRenderer.invoke("files:pick"),
  describeFiles: (paths) => ipcRenderer.invoke("files:describe", paths),
  prepareFile: (path) => ipcRenderer.invoke("files:prepare", path),
  // Chemin d'un fichier glissé-déposé dans la fenêtre.
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaCommand: (action, value) => ipcRenderer.invoke("media:command", { action, value }),
  onMediaState: (cb) => subscribe("media-state", cb),
  screenPermission: () => ipcRenderer.invoke("permission:screen"),
  openScreenSettings: () => ipcRenderer.invoke("permission:open-settings"),
  onStatus: (cb) => subscribe("status", cb),
  onNotice: (cb) => subscribe("notice", cb),
  onDisplaysChanged: (cb) => subscribe("displays-changed", cb),

  // Flux OBS
  obsInfo: () => ipcRenderer.invoke("obs:info"),
  onObs: (cb) => subscribe("obs", cb),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  sendRelayFrame: (frame) => ipcRenderer.send("relay:frame", frame),
  sendRelayChunk: (id, chunk) => ipcRenderer.send("relay:chunk", id, chunk),
  onRelayRecorder: (cb) => subscribe("relay:recorder", cb),
  onRelayQuality: (cb) => subscribe("relay:quality", cb),
  onRelayPcmMode: (cb) => subscribe("relay:pcm-mode", cb),
  onRelayPcm: (cb) => subscribe("relay:pcm", cb),
  setObsQuality: (height) => ipcRenderer.invoke("settings:obs-quality", height),
  setObsAudio: (value) => ipcRenderer.invoke("settings:obs-audio", value),
  onRelaySource: (cb) => subscribe("relay:source", cb),
  onRelayClients: (cb) => subscribe("relay:clients", cb),

  // Fenêtre de projection (fichiers)
  readSlidesPdf: () => ipcRenderer.invoke("files:read-slides-pdf"),
  sendMediaState: (state) => ipcRenderer.send("media:state", state),
  reportMediaError: (message) => ipcRenderer.send("media:error", message),
  onMediaCommand: (cb) => subscribe("media:command", cb),

  // Fenêtre de projection
  getCurrent: () => ipcRenderer.invoke("projector:current"),
  onSource: (cb) => subscribe("projector:source", cb),
  reportEnded: (reason) => ipcRenderer.send("projector:ended", reason),
  requestStop: () => ipcRenderer.send("projector:stop-request"),
});
