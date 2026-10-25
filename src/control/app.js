const api = window.diffusion;

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  banner: document.getElementById("permission-banner"),
  openSettings: document.getElementById("open-settings"),
  tabs: document.querySelectorAll(".tab"),
  search: document.getElementById("search"),
  refresh: document.getElementById("refresh"),
  grid: document.getElementById("source-grid"),
  empty: document.getElementById("source-empty"),
  preview: document.getElementById("preview"),
  previewPlaceholder: document.getElementById("preview-placeholder"),
  previewName: document.getElementById("preview-name"),
  display: document.getElementById("display"),
  displayWarning: document.getElementById("display-warning"),
  fit: document.getElementById("fit"),
  play: document.getElementById("play"),
  playLabel: document.getElementById("play-label"),
  stop: document.getElementById("stop"),
  toast: document.getElementById("toast"),
};

const SOURCE_REFRESH_MS = 4000;

const state = {
  sources: [],
  kind: "window",
  filter: "",
  selected: null, // { id, name }
  displays: [],
  displayId: null,
  fit: "contain",
  status: { live: false },
};

let previewStream = null;
let previewToken = 0;

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

function createCard(source) {
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
      card = createCard(source);
      cards.set(source.id, card);
    }
    updateCard(card, source);
    return card;
  });
  const current = Array.from(els.grid.children);
  if (current.length !== ordered.length || current.some((c, i) => c !== ordered[i])) {
    els.grid.replaceChildren(...ordered);
  }

  els.empty.hidden = visible.length > 0;
  els.empty.textContent =
    state.kind === "window" ? "Aucune fenêtre trouvée." : "Aucun écran trouvé.";
}

// --- Aperçu --------------------------------------------------------------

function stopPreview() {
  previewToken++;
  window.stopStream(previewStream);
  previewStream = null;
  els.preview.srcObject = null;
}

async function selectSource(source) {
  if (state.selected && state.selected.id === source.id && previewStream) return;
  state.selected = { id: source.id, name: source.name };
  renderSources();
  updateControls();
  stopPreview();

  const token = previewToken;
  els.previewPlaceholder.hidden = false;
  els.previewPlaceholder.textContent = "Chargement de l'aperçu…";
  els.previewName.textContent = source.name;
  try {
    const stream = await window.captureSource(source.id, {
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
    els.previewPlaceholder.hidden = true;
    const [track] = stream.getVideoTracks();
    if (track) {
      track.addEventListener("ended", () => {
        if (previewStream !== stream) return;
        stopPreview();
        els.previewPlaceholder.hidden = false;
        els.previewPlaceholder.textContent = "Cette fenêtre a été fermée.";
        refreshSources();
      });
    }
  } catch {
    if (token !== previewToken) return;
    els.previewPlaceholder.hidden = false;
    els.previewPlaceholder.textContent = "Impossible d'afficher l'aperçu de cette fenêtre.";
  }
}

function applyPreviewFit() {
  els.preview.classList.toggle("fit-cover", state.fit === "cover");
  els.preview.classList.toggle("fit-fill", state.fit === "fill");
}

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

async function play() {
  if (!state.selected || state.displayId === null) return;
  state.status = await api.start({
    sourceId: state.selected.id,
    sourceName: state.selected.name,
    displayId: state.displayId,
    fit: state.fit,
  });
  renderStatus();
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
  renderSources();
  updateControls();
}

function updateControls() {
  const { status, selected } = state;
  const isLiveSelection =
    status.live && selected && status.sourceId === selected.id && status.displayId === state.displayId;
  els.play.disabled = !selected || state.displayId === null || isLiveSelection;
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

els.tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    state.kind = tab.dataset.kind;
    els.tabs.forEach((t) => t.classList.toggle("active", t === tab));
    renderSources();
  })
);

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
  // Déjà en direct : on déplace la diffusion sur le nouvel écran.
  if (state.status.live && state.selected) play();
  else updateControls();
});

els.fit.addEventListener("change", async () => {
  state.fit = els.fit.value;
  applyPreviewFit();
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
  applyPreviewFit();

  const permission = await api.screenPermission();
  els.banner.hidden = permission === "granted";

  await refreshDisplays();
  state.status = await api.getStatus();
  await refreshSources();
  renderStatus();

  // Les miniatures et la liste des fenêtres ouvertes se mettent à jour
  // toutes seules tant que l'application est visible.
  setInterval(() => {
    if (!document.hidden) refreshSources();
  }, SOURCE_REFRESH_MS);
}

init();
