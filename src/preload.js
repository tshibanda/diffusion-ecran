const { contextBridge, ipcRenderer } = require("electron");

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
  youtubeInfo: (url) => ipcRenderer.invoke("youtube:info", url),
  youtubeState: () => ipcRenderer.invoke("youtube:state"),
  youtubeCommand: (action, value) => ipcRenderer.invoke("youtube:command", { action, value }),
  listDesktops: () => ipcRenderer.invoke("bureaux:list"),
  holdForeground: (on) => ipcRenderer.invoke("foreground:hold", on),
  openDiffusionBrowser: (url) => ipcRenderer.invoke("browser:open-diffusion", url),
  screenPermission: () => ipcRenderer.invoke("permission:screen"),
  openScreenSettings: () => ipcRenderer.invoke("permission:open-settings"),
  onStatus: (cb) => subscribe("status", cb),
  onNotice: (cb) => subscribe("notice", cb),
  onDisplaysChanged: (cb) => subscribe("displays-changed", cb),

  // Fenêtre de projection
  getCurrent: () => ipcRenderer.invoke("projector:current"),
  onSource: (cb) => subscribe("projector:source", cb),
  reportEnded: (reason) => ipcRenderer.send("projector:ended", reason),
  requestStop: () => ipcRenderer.send("projector:stop-request"),
});
