const api = window.diffusion;
const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  statusText: $("status-text"),
  banner: $("permission-banner"),
  openSettings: $("open-settings"),
  tabs: document.querySelectorAll(".tab"),
  search: $("search"),
  refresh: $("refresh"),
  grid: $("source-grid"),
  empty: $("source-empty"),
  youtubePanel: $("youtube-panel"),
  ytUrl: $("yt-url"),
  ytCard: $("yt-card"),
  ytThumb: $("yt-thumb"),
  ytTitle: $("yt-title"),
  ytAuthor: $("yt-author"),
  ytError: $("yt-error"),
  adblock: $("adblock"),
  previewBox: $("preview-box"),
  preview: $("preview"),
  previewThumb: $("preview-thumb"),
  previewPlaceholder: $("preview-placeholder"),
  previewName: $("preview-name"),
  cropLayer: $("crop-layer"),
  cropRect: $("crop-rect"),
  cropRow: $("crop-row"),
  cropText: $("crop-text"),
  cropReset: $("crop-reset"),
  cropHint: $("crop-hint"),
  display: $("display"),
  displayWarning: $("display-warning"),
  fitField: $("fit-field"),
  fit: $("fit"),
  play: $("play"),
  playLabel: $("play-label"),
  stop: $("stop"),
  remote: $("remote"),
  remoteAd: $("remote-ad"),
  remoteSeek: $("remote-seek"),
  remoteTime: $("remote-time"),
  remoteDuration: $("remote-duration"),
  remoteToggle: $("remote-toggle"),
  remoteMute: $("remote-mute"),
  remoteVolume: $("remote-volume"),
  toast: $("toast"),
};

const SOURCE_REFRESH_MS = 4000;
const REMOTE_REFRESH_MS = 1000;
const MIN_CROP = 0.03;

const state = {
  sources: [],
  kind: "window", // onglet : "window" | "screen" | "youtube"
  filter: "",
  selected: null, // fenêtre ou écran choisi : { id, name }
  crops: new Map(), // zone recadrée par fenêtre : id -> { x, y, w, h }
  youtube: null, // vidéo reconnue dans le champ YouTube
  displays: [],
  displayId: null,
  fit: "contain",
  status: { live: false },
};

const isYoutubeTab = () => state.kind === "youtube";
const currentCrop = () => (state.selected && state.crops.get(state.selected.id)) || null;

// --- Liste des fenêtres --------------------------------------------------

async function refreshSources() {
  try {
    state.sources = await api.listSources();
  } catch {
    state.sources = [];
  }
  const selected = state.selected && state.sources.find((s) => s.id === state.selected.id);
  if (selected) state.selected.name = selected.name;
  renderSources();
}

// Les cartes sont réutilisées d'un rafraîchissement à l'autre (seule la
// miniature change) pour ne pas perdre un clic en cours.
const cards = new Map();

function createCard() {
  const card = document.createElement("button");
  card.className = "card";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.alt = "";
  thumb.appendChild(img);
  card.appendChild(thumb);

  const label = document.createElement("div");
  label.className = "card-label";
  const icon = document.createElement("img");
  icon.alt = "";
  label.appendChild(icon);
  const name = document.createElement("span");
  label.appendChild(name);
  card.appendChild(label);

  card.addEventListener("click", () => selectSource(card.source));
  card.addEventListener("dblclick", () => {
    selectSource(card.source);
    play();
  });
  card.parts = { img, icon, name };
  return card;
}

function updateCard(card, source) {
  card.source = source;
  card.title = source.name;
  const { img, icon, name } = card.parts;
  if (img.getAttribute("src") !== (source.thumbnail || "")) img.src = source.thumbnail || "";
  img.hidden = !source.thumbnail;
  if (icon.getAttribute("src") !== (source.icon || "")) icon.src = source.icon || "";
  icon.hidden = !source.icon;
  name.textContent = source.name;
  card.classList.toggle("selected", !!state.selected && state.selected.id === source.id);
  card.classList.toggle("live", state.status.live && state.status.sourceId === source.id);
}

function renderSources() {
  const filter = state.filter.trim().toLowerCase();
  const visible = state.sources.filter(
    (s) => s.kind === state.kind && (!filter || s.name.toLowerCase().includes(filter))
  );

  const ids = new Set(state.sources.map((s) => s.id));
  for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);

  const ordered = visible.map((source) => {
    let card = cards.get(source.id);
    if (!card) {
      card = createCard();
      cards.set(source.id, card);
    }
    updateCard(card, source);
    return card;
  });
  const current = Array.from(els.grid.children);
  if (current.length !== ordered.length || current.some((c, i) => c !== ordered[i])) {
    els.grid.replaceChildren(...ordered);
  }

  els.empty.hidden = isYoutubeTab() || visible.length > 0;
  els.empty.textContent =
    state.kind === "window" ? "Aucune fenêtre trouvée." : "Aucun écran trouvé.";
}

function selectSource(source) {
  state.selected = { id: source.id, name: source.name };
  renderSources();
  renderPreview();
  updateControls();
}

// --- Aperçu --------------------------------------------------------------
// Onglets Fenêtres / Écrans : la fenêtre choisie, en direct.
// Onglet YouTube : la miniature de la vidéo, puis pendant la diffusion ce
// qui est réellement affiché sur l'écran de projection.

let previewStream = null;
let previewFor = null;
let previewToken = 0;

function stopPreview() {
  previewToken++;
  window.stopStream(previewStream);
  previewStream = null;
  previewFor = null;
  els.preview.srcObject = null;
}

function setPlaceholder(text) {
  els.previewPlaceholder.hidden = !text;
  els.previewPlaceholder.textContent = text || "";
}

function wantedPreview() {
  if (isYoutubeTab()) {
    const { status } = state;
    if (status.live && status.kind === "youtube" && status.previewSourceId) {
      return { stream: status.previewSourceId, name: status.sourceName, crop: false };
    }
    if (state.youtube) return { thumb: state.youtube.thumbnail, name: state.youtube.title || "" };
    return { text: "Collez le lien d'une vidéo YouTube à gauche." };
  }
  if (state.selected) return { stream: state.selected.id, name: state.selected.name, crop: true };
  return { text: "Choisissez une fenêtre à gauche pour la voir ici." };
}

async function renderPreview() {
  const wanted = wantedPreview();
  els.previewName.textContent = wanted.name || "";
  els.cropLayer.hidden = !wanted.crop || !previewStream || previewFor !== wanted.stream;

  if (!wanted.stream) {
    stopPreview();
    els.previewThumb.hidden = !wanted.thumb;
    if (wanted.thumb) els.previewThumb.src = wanted.thumb;
    setPlaceholder(wanted.thumb ? "" : wanted.text);
    renderCrop();
    return;
  }
  els.previewThumb.hidden = true;
  if (previewFor === wanted.stream) {
    renderCrop();
    return;
  }

  stopPreview();
  const token = previewToken;
  previewFor = wanted.stream;
  setPlaceholder("Chargement de l'aperçu…");
  renderCrop();
  try {
    const stream = await window.captureSource(wanted.stream, {
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: 30,
    });
    if (token !== previewToken) {
      window.stopStream(stream);
      return;
    }
    previewStream = stream;
    els.preview.srcObject = stream;
    setPlaceholder("");
    els.cropLayer.hidden = !wanted.crop;
    const [track] = stream.getVideoTracks();
    if (track) {
      track.addEventListener("ended", () => {
        if (previewStream !== stream) return;
        stopPreview();
        els.cropLayer.hidden = true;
        setPlaceholder("Cette fenêtre a été fermée.");
        refreshSources();
      });
    }
  } catch {
    if (token !== previewToken) return;
    setPlaceholder("Impossible d'afficher l'aperçu de cette fenêtre.");
  }
}

// --- Zone recadrée (plein écran d'une partie de la fenêtre) ---------------

// Rectangle (en pixels, relatif à l'aperçu) où l'image est réellement
// dessinée, bandes noires exclues.
function displayedVideoRect() {
  const W = els.preview.videoWidth;
  const H = els.preview.videoHeight;
  const bw = els.previewBox.clientWidth;
  const bh = els.previewBox.clientHeight;
  if (!W || !H) return { left: 0, top: 0, width: bw, height: bh };
  const scale = Math.min(bw / W, bh / H);
  const width = W * scale;
  const height = H * scale;
  return { left: (bw - width) / 2, top: (bh - height) / 2, width, height };
}

function drawCropRect(crop) {
  els.cropRect.hidden = !crop;
  if (!crop) return;
  Object.assign(els.cropRect.style, {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  });
}

function renderCrop() {
  const rect = displayedVideoRect();
  Object.assign(els.cropLayer.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const crop = currentCrop();
  drawCropRect(crop);

  const show = !isYoutubeTab() && !!state.selected;
  els.cropRow.hidden = !show;
  els.cropHint.hidden = !show;
  els.cropReset.hidden = !crop;
  const whole = state.kind === "screen" ? "écran entier" : "fenêtre entière";
  els.cropText.textContent = crop
    ? `Zone diffusée : partie sélectionnée (${Math.round(crop.w * 100)} × ${Math.round(crop.h * 100)} %)`
    : `Zone diffusée : ${whole}`;
  els.cropReset.textContent = state.kind === "screen" ? "Écran entier" : "Fenêtre entière";
}

function setCrop(crop) {
  if (!state.selected) return;
  if (crop) state.crops.set(state.selected.id, crop);
  else state.crops.delete(state.selected.id);
  renderCrop();
  const { status } = state;
  if (status.live && status.kind === "capture" && status.sourceId === state.selected.id) {
    api.setCrop(state.selected.id, crop);
  }
}

let dragStart = null;

function pointerToFraction(event) {
  const r = els.cropLayer.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)),
  };
}

function rectBetween(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

els.cropLayer.addEventListener("pointerdown", (event) => {
  dragStart = pointerToFraction(event);
  els.cropLayer.setPointerCapture(event.pointerId);
});

els.cropLayer.addEventListener("pointermove", (event) => {
  if (dragStart) drawCropRect(rectBetween(dragStart, pointerToFraction(event)));
});

els.cropLayer.addEventListener("pointerup", (event) => {
  if (!dragStart) return;
  const rect = rectBetween(dragStart, pointerToFraction(event));
  dragStart = null;
  // Un simple clic (sans tracer) ne change rien.
  if (rect.w >= MIN_CROP && rect.h >= MIN_CROP) setCrop(rect);
  else renderCrop();
});

els.cropLayer.addEventListener("pointercancel", () => {
  dragStart = null;
  renderCrop();
});

els.cropReset.addEventListener("click", () => setCrop(null));
els.preview.addEventListener("loadedmetadata", renderCrop);
els.preview.addEventListener("resize", renderCrop);
new ResizeObserver(renderCrop).observe(els.previewBox);

// --- YouTube -------------------------------------------------------------

let ytLookupTimer = null;
let ytLookupToken = 0;

async function lookupYoutube() {
  const text = els.ytUrl.value.trim();
  const token = ++ytLookupToken;
  if (!text) {
    state.youtube = null;
    renderYoutube();
    return;
  }
  const info = await api.youtubeInfo(text);
  if (token !== ytLookupToken) return;
  state.youtube = info.ok ? info : null;
  renderYoutube(!info.ok);
}

function renderYoutube(invalid = false) {
  const yt = state.youtube;
  els.ytCard.hidden = !yt;
  els.ytError.hidden = !invalid;
  if (yt) {
    els.ytThumb.src = yt.thumbnail;
    els.ytTitle.textContent = yt.title || "Vidéo YouTube";
    els.ytAuthor.textContent = yt.author || "";
  }
  renderPreview();
  updateControls();
}

function renderAdblock() {
  const value = state.status.adblock;
  els.adblock.className = `adblock ${value || ""}`;
  els.adblock.textContent =
    value === "on"
      ? "🛡 Bloqueur de publicités actif (listes uBlock Origin + EasyList) — les publicités restantes sont passées automatiquement."
      : value === "off"
        ? "Bloqueur de publicités indisponible (pas de connexion ?). Les publicités sont tout de même passées automatiquement."
        : "Bloqueur de publicités : chargement des listes…";
}

// Miniature introuvable (hors ligne…) : pas d'image cassée.
for (const img of [els.ytThumb, els.previewThumb]) {
  img.addEventListener("error", () => (img.style.visibility = "hidden"));
  img.addEventListener("load", () => (img.style.visibility = ""));
}

els.ytUrl.addEventListener("input", () => {
  clearTimeout(ytLookupTimer);
  ytLookupTimer = setTimeout(lookupYoutube, 350);
});

els.ytUrl.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  clearTimeout(ytLookupTimer);
  await lookupYoutube();
  if (state.youtube) play();
});

// Télécommande : interroge la vidéo en cours toutes les secondes.
let seeking = false;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

async function refreshRemote() {
  const { status } = state;
  const active = status.live && status.kind === "youtube";
  els.remote.hidden = !active;
  if (!active) return;
  const yt = await api.youtubeState();
  if (!yt || !yt.ready) {
    els.remoteAd.hidden = true;
    els.remoteTime.textContent = "Chargement…";
    return;
  }
  els.remoteAd.hidden = !yt.ad;
  els.remoteToggle.textContent = yt.paused ? "▶ Lecture" : "❚❚ Pause";
  els.remoteMute.textContent = yt.muted ? "Remettre le son" : "Couper le son";
  if (document.activeElement !== els.remoteVolume) els.remoteVolume.value = String(yt.volume);
  if (!seeking && !yt.ad) {
    els.remoteSeek.max = String(Math.floor(yt.duration));
    els.remoteSeek.value = String(Math.floor(yt.time));
    els.remoteTime.textContent = formatTime(yt.time);
    els.remoteDuration.textContent = formatTime(yt.duration);
  }
}

els.remote.querySelectorAll("[data-yt]").forEach((button) =>
  button.addEventListener("click", async () => {
    await api.youtubeCommand(button.dataset.yt, Number(button.dataset.value || 0));
    refreshRemote();
  })
);

els.remoteSeek.addEventListener("input", () => {
  seeking = true;
  els.remoteTime.textContent = formatTime(Number(els.remoteSeek.value));
});

els.remoteSeek.addEventListener("change", async () => {
  await api.youtubeCommand("seek-to", Number(els.remoteSeek.value));
  seeking = false;
  refreshRemote();
});

els.remoteVolume.addEventListener("input", () =>
  api.youtubeCommand("volume", Number(els.remoteVolume.value))
);

// --- Écrans --------------------------------------------------------------

async function refreshDisplays() {
  state.displays = await api.listDisplays();
  if (!state.displays.some((d) => d.id === state.displayId)) {
    const secondary = state.displays.find((d) => !d.primary);
    state.displayId = (secondary || state.displays[0] || {}).id ?? null;
  }

  els.display.replaceChildren(
    ...state.displays.map((d) => {
      const option = document.createElement("option");
      option.value = String(d.id);
      const tags = [];
      if (d.primary) tags.push("principal");
      if (d.hasControl) tags.push("cette fenêtre");
      option.textContent =
        `${d.index}. ${d.label} — ${d.width}×${d.height}` +
        (tags.length ? ` (${tags.join(", ")})` : "");
      return option;
    })
  );
  if (state.displayId !== null) els.display.value = String(state.displayId);
  updateDisplayWarning();
}

function updateDisplayWarning() {
  const target = state.displays.find((d) => d.id === state.displayId);
  let message = "";
  if (state.displays.length < 2) {
    message =
      "Un seul écran détecté : branchez le second écran. Sinon, la projection couvrira cet écran (Échap pour l'arrêter).";
  } else if (target && target.hasControl) {
    message = "Attention : cet écran est celui où se trouve cette fenêtre de contrôle.";
  }
  els.displayWarning.textContent = message;
  els.displayWarning.hidden = !message;
}

// --- Diffusion -----------------------------------------------------------

async function start(request) {
  const result = await api.start({ ...request, displayId: state.displayId });
  if (result.error) showToast(result.error);
  state.status = result;
  renderStatus();
}

function play() {
  if (state.displayId === null) return;
  if (isYoutubeTab()) {
    if (!state.youtube) return;
    start({ kind: "youtube", url: state.youtube.watchUrl, title: state.youtube.title });
  } else {
    if (!state.selected) return;
    start({
      kind: "capture",
      sourceId: state.selected.id,
      sourceName: state.selected.name,
      fit: state.fit,
      crop: currentCrop(),
    });
  }
}

// Changement d'écran pendant la diffusion : on déplace ce qui passe déjà.
function moveLive() {
  const { status } = state;
  if (status.kind === "youtube") {
    start({ kind: "youtube", url: status.watchUrl, title: status.sourceName });
  } else {
    start({
      kind: "capture",
      sourceId: status.sourceId,
      sourceName: status.sourceName,
      fit: state.fit,
      crop: state.crops.get(status.sourceId) || null,
    });
  }
}

async function stop() {
  state.status = await api.stop();
  renderStatus();
}

function renderStatus() {
  const { status } = state;
  els.status.classList.toggle("on", status.live);
  els.status.classList.toggle("off", !status.live);
  els.statusText.textContent = status.live
    ? `En direct : ${status.sourceName} → ${status.displayLabel}`
    : "Hors diffusion";
  renderAdblock();
  renderSources();
  renderPreview();
  updateControls();
  refreshRemote();
}

function updateControls() {
  const { status } = state;
  const sameDisplay = status.displayId === state.displayId;
  let ready;
  let isLiveSelection;
  if (isYoutubeTab()) {
    ready = !!state.youtube;
    isLiveSelection =
      status.live && status.kind === "youtube" && ready && status.watchUrl === state.youtube.watchUrl;
  } else {
    ready = !!state.selected;
    isLiveSelection =
      status.live && status.kind === "capture" && ready && status.sourceId === state.selected.id;
  }
  isLiveSelection = isLiveSelection && sameDisplay;

  els.play.disabled = !ready || state.displayId === null || isLiveSelection;
  if (isLiveSelection) els.playLabel.textContent = "En diffusion";
  else if (status.live) els.playLabel.textContent = "Diffuser à la place";
  else els.playLabel.textContent = "Diffuser";
  els.stop.disabled = !status.live;
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 5000);
}

// --- Événements ----------------------------------------------------------

function setTab(kind) {
  state.kind = kind;
  els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.kind === kind));
  const youtube = isYoutubeTab();
  els.youtubePanel.hidden = !youtube;
  els.grid.hidden = youtube;
  els.search.hidden = youtube;
  els.refresh.hidden = youtube;
  els.fitField.hidden = youtube;
  // La sélection d'une fenêtre ne passe pas d'un onglet à l'autre.
  if (!youtube && state.selected) {
    const source = state.sources.find((s) => s.id === state.selected.id);
    if (!source || source.kind !== kind) state.selected = null;
  }
  renderSources();
  renderPreview();
  updateControls();
  if (youtube) els.ytUrl.focus();
}

els.tabs.forEach((tab) => tab.addEventListener("click", () => setTab(tab.dataset.kind)));

els.search.addEventListener("input", () => {
  state.filter = els.search.value;
  renderSources();
});

els.refresh.addEventListener("click", () => {
  refreshSources();
  refreshDisplays();
});

els.display.addEventListener("change", () => {
  state.displayId = Number(els.display.value);
  updateDisplayWarning();
  if (state.status.live) moveLive();
  else updateControls();
});

els.fit.addEventListener("change", async () => {
  state.fit = els.fit.value;
  state.status = await api.setFit(state.fit);
  renderStatus();
});

els.play.addEventListener("click", play);
els.stop.addEventListener("click", stop);
els.openSettings.addEventListener("click", () => api.openScreenSettings());

api.onStatus((status) => {
  state.status = status;
  renderStatus();
});
api.onNotice(showToast);
api.onDisplaysChanged(refreshDisplays);

// --- Démarrage -----------------------------------------------------------

async function init() {
  const settings = await api.getSettings();
  state.displayId = settings.displayId;
  state.fit = settings.fit;
  els.fit.value = state.fit;

  const permission = await api.screenPermission();
  els.banner.hidden = permission === "granted";

  await refreshDisplays();
  state.status = await api.getStatus();
  await refreshSources();
  renderStatus();

  // Les miniatures et la liste des fenêtres ouvertes se mettent à jour
  // toutes seules tant que l'application est visible.
  setInterval(() => {
    if (!document.hidden && !isYoutubeTab()) refreshSources();
  }, SOURCE_REFRESH_MS);
  setInterval(() => {
    if (!document.hidden) refreshRemote();
  }, REMOTE_REFRESH_MS);
}

init();
