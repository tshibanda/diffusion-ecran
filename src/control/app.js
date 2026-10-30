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
  desktops: $("desktops"),
  desktopList: $("desktop-list"),
  desktopInfo: $("desktop-info"),
  empty: $("source-empty"),
  filesPanel: $("files-panel"),
  filesAdd: $("files-add"),
  filesList: $("files-list"),
  filesEmpty: $("files-empty"),
  previewBox: $("preview-box"),
  preview: $("preview"),
  previewThumb: $("preview-thumb"),
  previewPlaceholder: $("preview-placeholder"),
  previewName: $("preview-name"),
  previewWarning: $("preview-warning"),
  liveNote: $("live-note"),
  browserTip: $("browser-tip"),
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
  remoteMedia: $("remote-media"),
  remoteSlides: $("remote-slides"),
  remoteSlidesHint: $("remote-slides-hint"),
  remoteSlide: $("remote-slide"),
  remoteLoop: $("remote-loop"),
  remoteSeek: $("remote-seek"),
  remoteTime: $("remote-time"),
  remoteDuration: $("remote-duration"),
  remoteToggle: $("remote-toggle"),
  remoteMute: $("remote-mute"),
  remoteVolume: $("remote-volume"),
  toast: $("toast"),
};

const SOURCE_REFRESH_MS = 4000;
const MIN_CROP = 0.03;

const state = {
  sources: [],
  kind: "window", // onglet : "window" | "screen" | "files"
  filter: "",
  selected: null, // fenêtre ou écran choisi : { id, name }
  crops: new Map(), // zone recadrée par fenêtre : id -> { x, y, w, h }
  files: [], // fichiers de la liste (voir fichiers.js : describe)
  selectedFile: null, // chemin du fichier choisi
  prepared: new Map(), // chemin -> { pending } | { ok, slides } | { error }
  media: null, // état renvoyé par l'écran de projection (lecture, diapositive)
  displays: [],
  displayId: null,
  fit: "contain",
  status: { live: false },
  // Bureaux virtuels de Windows : { desktops, windows, current, pinAvailable }
  desktops: null,
  desktopView: null, // bureau affiché dans l'onglet Fenêtres (null = bureau actuel)
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isFilesTab = () => state.kind === "files";
// Windows : « Diffuser » place la fenêtre elle-même sur l'écran de projection.
const placesWindows = () => api.platform === "win32";
const currentCrop = () => (state.selected && state.crops.get(state.selected.id)) || null;

// --- Liste des fenêtres --------------------------------------------------

async function refreshSources() {
  const desktops = refreshDesktops();
  try {
    state.sources = await api.listSources();
  } catch {
    state.sources = [];
  }
  await desktops;
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
  const placeholder = document.createElement("span");
  placeholder.className = "thumb-label";
  thumb.appendChild(placeholder);
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
  card.parts = { img, icon, name, placeholder };
  return card;
}

function updateCard(card, source) {
  card.source = source;
  card.title = source.name;
  const { img, icon, name, placeholder } = card.parts;
  placeholder.textContent = source.other
    ? `${source.process || "Fenêtre"}${source.minimized ? " (réduite)" : ""}`
    : "";
  placeholder.hidden = !source.other;
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
  const visible = visibleSources().filter(
    (s) => !filter || s.name.toLowerCase().includes(filter)
  );
  renderDesktops();

  const ids = new Set([...state.sources, ...otherDesktopSources()].map((s) => s.id));
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

  els.empty.hidden = isFilesTab() || visible.length > 0;
  els.empty.textContent =
    state.kind === "window" ? "Aucune fenêtre trouvée." : "Aucun écran trouvé.";
}

// --- Bureaux virtuels (Windows + Tab) --------------------------------------
// Windows ne propose que les fenêtres du bureau affiché : celles des autres
// bureaux sont listées par l'assistant (lecture seule) et capturées
// directement, sans changer de bureau ni toucher à la fenêtre.

async function refreshDesktops() {
  if (api.platform !== "win32") return;
  let result = null;
  try {
    result = await api.listDesktops();
  } catch {
    // Assistant indisponible : on garde l'affichage simple.
  }
  state.desktops = result && result.available ? result : null;
  const ids = state.desktops ? state.desktops.desktops.map((d) => d.id) : [];
  if (!ids.includes(state.desktopView) || state.desktopView === currentDesktopId()) {
    state.desktopView = null;
  }
}

const currentDesktopId = () => (state.desktops ? state.desktops.current : null);
const viewingOtherDesktop = () =>
  state.kind === "window" && !!state.desktops && state.desktopView !== null;

function desktopLabel(d) {
  return d.name || `Bureau ${d.index}`;
}

function otherDesktopSources() {
  if (!state.desktops) return [];
  return state.desktops.windows
    .filter((w) => !w.onCurrent && !w.pinned)
    .map((w) => ({
      id: `window:${w.hwnd}:0`,
      name: w.title,
      kind: "window",
      thumbnail: null,
      icon: null,
      other: true,
      hwnd: w.hwnd,
      desktop: w.desktop,
      process: w.process,
      minimized: w.minimized,
    }));
}

function visibleSources() {
  if (viewingOtherDesktop()) {
    return otherDesktopSources().filter((s) => s.desktop === state.desktopView);
  }
  return state.sources.filter((s) => s.kind === state.kind);
}

function renderDesktops() {
  const d = state.desktops;
  const show = state.kind === "window" && !!d && d.desktops.length > 1;
  els.desktops.hidden = !show;
  els.desktopInfo.hidden = !show || !viewingOtherDesktop();
  if (!show) return;

  const counts = new Map();
  for (const w of d.windows) {
    if (!w.pinned) counts.set(w.desktop, (counts.get(w.desktop) || 0) + 1);
  }
  const chips = d.desktops.map((desktop) => {
    const chip = document.createElement("button");
    chip.className = "desktop-chip";
    const active = state.desktopView === null ? desktop.current : state.desktopView === desktop.id;
    chip.classList.toggle("active", active);
    chip.classList.toggle("current", desktop.current);
    const n = counts.get(desktop.id) || 0;
    chip.title =
      `${n} fenêtre${n > 1 ? "s" : ""} — ` +
      (desktop.current ? "bureau affiché en ce moment" : "cliquez pour voir ses fenêtres");
    chip.textContent = desktopLabel(desktop);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `· ${n}`;
    chip.appendChild(count);
    chip.addEventListener("click", () => {
      state.desktopView = desktop.current ? null : desktop.id;
      renderSources();
    });
    return chip;
  });
  els.desktopList.replaceChildren(...chips);

  const viewed = d.desktops.find((x) => x.id === state.desktopView);
  if (viewed) {
    els.desktopInfo.textContent = `Fenêtres du bureau « ${desktopLabel(viewed)} ». Elles se prévisualisent et se diffusent d'ici, sans changer de bureau ni déplacer la fenêtre.`;
  }
}

function selectSource(source) {
  state.selected = { id: source.id, name: source.name, other: !!source.other };
  renderSources();
  renderPreview();
  updateControls();
}

// --- Aperçu --------------------------------------------------------------
// Onglets Fenêtres / Écrans : la fenêtre choisie, en direct.
// Onglet Fichiers : un aperçu du fichier choisi, puis pendant la diffusion ce
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
  if (els.preview.hasAttribute("src")) {
    els.preview.removeAttribute("src");
    els.preview.load();
  }
}

function setPlaceholder(text) {
  els.previewPlaceholder.hidden = !text;
  els.previewPlaceholder.textContent = text || "";
}

function wantedPreview() {
  if (isFilesTab()) {
    const { status } = state;
    const file = selectedFile();
    const liveFile = status.live && status.kind === "file" && status.previewSourceId;
    if (liveFile && (!file || file.path === status.file.path)) {
      return { stream: status.previewSourceId, name: status.sourceName, crop: false };
    }
    if (!file) return { text: "Choisissez un fichier à gauche pour le voir ici." };
    if (file.type === "image") return { thumb: file.url, name: file.name };
    if (file.type === "video") return { fileVideo: file.url, name: file.name };
    return { text: fileStatusText(file), name: file.name };
  }
  if (state.selected) {
    return {
      stream: state.selected.id,
      name: state.selected.name,
      crop: true,
      other: state.selected.other,
    };
  }
  return { text: "Choisissez une fenêtre à gauche pour la voir ici." };
}

async function renderPreview() {
  const wanted = wantedPreview();
  els.previewName.textContent = wanted.name || "";
  // Fenêtre de navigateur : sa vidéo apparaît figée/noire si la fenêtre est
  // sur un autre bureau ou cachée ; on propose l'onglet Fichiers.
  // Sous Windows, une fenêtre entière est placée elle-même sur l'écran de
  // projection : le problème n'existe que pour une zone recadrée (capture).
  els.browserTip.hidden = !(
    wanted.crop &&
    (!placesWindows() || !!currentCrop()) &&
    /chrome|edge|brave|opera|firefox|youtube/i.test(wanted.name || "")
  );
  if (previewFor !== wanted.stream) els.previewWarning.hidden = true;
  els.cropLayer.hidden = !wanted.crop || !previewStream || previewFor !== wanted.stream;

  if (wanted.fileVideo) {
    // Vidéo pas encore diffusée : lue sans le son dans l'aperçu.
    if (els.preview.getAttribute("src") !== wanted.fileVideo) {
      stopPreview();
      els.preview.src = wanted.fileVideo;
    }
    els.previewThumb.hidden = true;
    setPlaceholder("");
    renderCrop();
    return;
  }
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
    if (wanted.other) watchPreviewImage(stream);
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
    setPlaceholder(
      wanted.other
        ? "Windows refuse de fournir l'image de cette fenêtre tant que son bureau n'est pas affiché."
        : "Impossible d'afficher l'aperçu de cette fenêtre."
    );
  }
}

// Fenêtre d'un autre bureau : Windows peut ne pas fournir son image (image
// absente ou noire). On le signale sous l'aperçu, sans rien changer d'autre.
const probe = document.createElement("canvas");
probe.width = 32;
probe.height = 18;

function previewLooksEmpty() {
  const v = els.preview;
  if (!v.videoWidth) return true;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, probe.width, probe.height);
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
  return max < 6;
}

async function watchPreviewImage(stream) {
  await sleep(2500);
  while (previewStream === stream) {
    const empty = previewLooksEmpty();
    els.previewWarning.hidden = !empty;
    els.previewWarning.textContent = empty
      ? "Aucune image reçue pour l'instant de cette fenêtre (autre bureau). Si cela dure, Windows ne la fournit pas tant que son bureau n'est pas affiché ; vérifiez aussi qu'elle n'est pas réduite."
      : "";
    if (!empty) return;
    await sleep(2000);
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

  const show = !isFilesTab() && !!state.selected;
  els.cropRow.hidden = !show;
  els.cropHint.hidden = !show;
  els.cropHint.textContent =
    placesWindows() && state.kind === "window"
      ? crop
        ? "Zone recadrée : la fenêtre reste à sa place et seule cette zone est copiée sur l'écran de projection (la fenêtre doit rester visible sur le bureau affiché)."
        : "Diffuser place cette fenêtre en plein écran sur l'écran de projection, même si elle est sur un autre bureau ; elle retrouve sa place à l'arrêt. Pour n'envoyer qu'une partie de la fenêtre, tracez un rectangle sur l'aperçu."
      : "Plein écran d'une partie seulement (ex. la vidéo dans une fenêtre Chrome) : tracez un rectangle sur l'aperçu avec la souris.";
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

// --- Fichiers --------------------------------------------------------------

const FILE_TYPES = {
  video: { icon: "🎬", label: "Vidéo" },
  audio: { icon: "🎵", label: "Son" },
  image: { icon: "🖼", label: "Image" },
  pdf: { icon: "📄", label: "PDF" },
  presentation: { icon: "📊", label: "Présentation" },
};

const selectedFile = () => state.files.find((f) => f.path === state.selectedFile) || null;
const hasSlides = (file) => file.type === "pdf" || file.type === "presentation";

function fileStatusText(file) {
  const label = FILE_TYPES[file.type].label;
  if (!hasSlides(file)) return label;
  const prep = state.prepared.get(file.path);
  if (!prep || prep.pending) return file.type === "presentation" ? `${label} · conversion en cours…` : label;
  if (prep.error) return `${label} · ${prep.error}`;
  return `${label} · prête`;
}

function renderFiles() {
  const live = state.status.live && state.status.kind === "file" ? state.status.file.path : null;
  els.filesEmpty.hidden = state.files.length > 0;
  els.filesList.replaceChildren(
    ...state.files.map((file) => {
      const li = document.createElement("li");
      li.className = "file-item";
      li.classList.toggle("selected", file.path === state.selectedFile);
      li.classList.toggle("live", file.path === live);
      li.title = file.path;

      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = FILE_TYPES[file.type].icon;
      const text = document.createElement("div");
      text.className = "file-text";
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = file.name;
      const type = document.createElement("div");
      type.className = "file-type";
      type.textContent = fileStatusText(file);
      text.append(name, type);
      li.append(icon, text);

      if (file.path === live) {
        const badge = document.createElement("span");
        badge.className = "file-badge";
        badge.textContent = "EN DIRECT";
        li.append(badge);
      }
      const remove = document.createElement("button");
      remove.className = "file-remove";
      remove.title = "Retirer de la liste (le fichier n'est pas supprimé)";
      remove.textContent = "✕";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeFile(file.path);
      });
      li.append(remove);

      li.addEventListener("click", () => selectFile(file.path));
      li.addEventListener("dblclick", () => {
        selectFile(file.path);
        play();
      });
      return li;
    })
  );
}

// Les présentations sont converties dès qu'elles sont choisies : la diffusion
// démarre ensuite sans attendre.
async function prepareFile(file) {
  if (!hasSlides(file) || state.prepared.has(file.path)) return;
  state.prepared.set(file.path, { pending: true });
  renderFiles();
  const result = await api.prepareFile(file.path);
  state.prepared.set(file.path, result.ok ? { ok: true, slides: result.slides } : { error: result.error });
  renderFiles();
  if (state.selectedFile === file.path) renderPreview();
}

function selectFile(filePath) {
  state.selectedFile = filePath;
  const file = selectedFile();
  if (file) prepareFile(file);
  renderFiles();
  renderPreview();
  updateControls();
}

function addFiles(items) {
  const known = new Set(state.files.map((f) => f.path));
  const added = items.filter((item) => !known.has(item.path));
  if (!added.length) return;
  state.files.push(...added);
  api.saveFiles(state.files.map((f) => f.path));
  selectFile(added[0].path);
}

function removeFile(filePath) {
  state.files = state.files.filter((f) => f.path !== filePath);
  if (state.selectedFile === filePath) state.selectedFile = null;
  api.saveFiles(state.files.map((f) => f.path));
  renderFiles();
  renderPreview();
  updateControls();
}

els.filesAdd.addEventListener("click", async () => addFiles(await api.pickFiles()));

// Glisser-déposer des fichiers depuis l'Explorateur / le Finder.
els.filesPanel.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.filesPanel.classList.add("dragging");
});
els.filesPanel.addEventListener("dragleave", () => els.filesPanel.classList.remove("dragging"));
els.filesPanel.addEventListener("drop", async (event) => {
  event.preventDefault();
  els.filesPanel.classList.remove("dragging");
  const paths = [...event.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  const items = await api.describeFiles(paths);
  if (items.length < paths.length) showToast("Certains fichiers ne sont pas pris en charge.");
  addFiles(items);
});

// Miniature introuvable : pas d'image cassée.
els.previewThumb.addEventListener("error", () => (els.previewThumb.style.visibility = "hidden"));
els.previewThumb.addEventListener("load", () => (els.previewThumb.style.visibility = ""));

// --- Télécommande (fichier diffusé) --------------------------------------------

let seeking = false;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function renderRemote() {
  const { status, media } = state;
  const active = status.live && status.kind === "file" && !!media && media.type !== "image";
  els.remote.hidden = !active;
  if (!active) return;
  const slides = media.type === "slides";
  els.remoteMedia.hidden = slides;
  els.remoteSlides.hidden = !slides;
  els.remoteSlidesHint.hidden = !slides;
  if (slides) {
    els.remoteSlide.textContent = `${media.index + 1} / ${media.count}`;
    return;
  }
  els.remoteToggle.textContent = media.paused || media.ended ? "▶ Lecture" : "❚❚ Pause";
  els.remoteMute.textContent = media.muted ? "Remettre le son" : "Couper le son";
  els.remoteLoop.checked = media.loop;
  if (document.activeElement !== els.remoteVolume) els.remoteVolume.value = String(media.volume);
  if (!seeking) {
    els.remoteSeek.max = String(media.duration || 0);
    els.remoteSeek.value = String(media.time);
    els.remoteTime.textContent = formatTime(media.time);
    els.remoteDuration.textContent = formatTime(media.duration);
  }
}

els.remote.querySelectorAll("[data-media]").forEach((button) =>
  button.addEventListener("click", () =>
    api.mediaCommand(button.dataset.media, Number(button.dataset.value || 0))
  )
);

els.remoteSeek.addEventListener("input", () => {
  seeking = true;
  els.remoteTime.textContent = formatTime(Number(els.remoteSeek.value));
});

els.remoteSeek.addEventListener("change", async () => {
  await api.mediaCommand("seek-to", Number(els.remoteSeek.value));
  seeking = false;
});

els.remoteVolume.addEventListener("input", () =>
  api.mediaCommand("volume", Number(els.remoteVolume.value))
);

els.remoteLoop.addEventListener("change", () => api.mediaCommand("loop", els.remoteLoop.checked ? 1 : 0));

// Clavier de la régie : diapositive suivante / précédente, lecture / pause.
document.addEventListener("keydown", (event) => {
  const { status, media } = state;
  if (!status.live || status.kind !== "file" || !media) return;
  if (event.target.closest("input, select, textarea")) return;
  const key = event.key;
  if (media.type === "slides") {
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) api.mediaCommand("next");
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) api.mediaCommand("prev");
    else if (key === "Home") api.mediaCommand("goto", 0);
    else if (key === "End") api.mediaCommand("goto", media.count - 1);
    else return;
  } else if (media.type === "media" && key === " ") {
    api.mediaCommand("toggle");
  } else {
    return;
  }
  event.preventDefault();
});

api.onMediaState((media) => {
  state.media = media;
  renderRemote();
});

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
  if (isFilesTab()) {
    const file = selectedFile();
    if (!file) return;
    if (file.type === "presentation" && state.prepared.get(file.path)?.pending) {
      showToast("Conversion de la présentation en cours, la diffusion démarre dès qu'elle est prête…");
    }
    start({ kind: "file", path: file.path, fit: state.fit });
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
  if (status.kind === "file") {
    start({ kind: "file", path: status.file.path, fit: state.fit });
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
  els.liveNote.hidden = !(status.live && status.kind === "move" && status.otherDesktop);
  if (!(status.live && status.kind === "file")) state.media = null;
  renderSources();
  renderFiles();
  renderPreview();
  updateControls();
  renderRemote();
}

function updateControls() {
  const { status } = state;
  const sameDisplay = status.displayId === state.displayId;
  let ready;
  let isLiveSelection;
  if (isFilesTab()) {
    const file = selectedFile();
    ready = !!file;
    isLiveSelection = status.live && status.kind === "file" && ready && status.file.path === file.path;
  } else {
    ready = !!state.selected;
    isLiveSelection =
      status.live &&
      (status.kind === "capture" || status.kind === "move") &&
      ready &&
      status.sourceId === state.selected.id;
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
  const files = isFilesTab();
  els.filesPanel.hidden = !files;
  els.grid.hidden = files;
  els.search.hidden = files;
  els.refresh.hidden = files;
  // La sélection d'une fenêtre ne passe pas d'un onglet à l'autre.
  if (!files && state.selected) {
    const source = [...state.sources, ...otherDesktopSources()].find(
      (s) => s.id === state.selected.id
    );
    if (!source || source.kind !== kind) state.selected = null;
  }
  renderSources();
  renderFiles();
  renderPreview();
  updateControls();
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

// --- Flux OBS --------------------------------------------------------------

function renderObs(info) {
  if (!info) return;
  $("obs-page").textContent = info.urls ? info.urls.page : "Indisponible (port occupé)";
  $("obs-stream").textContent = info.urls ? info.urls.stream : "—";
  const status = $("obs-status");
  status.classList.toggle("on", info.clients > 0);
  status.textContent =
    info.clients > 0 ? `● OBS connecté${info.clients > 1 ? ` (${info.clients})` : ""}` : "Non connecté";
  $("obs-audio").checked = info.audio;
  $("obs-quality").value = String(info.quality);
  const audioTexts = {
    file: "Son : uniquement celui du fichier diffusé.",
    window: info.audioError
      ? `Son de la fenêtre indisponible : ${info.audioError} (Windows 10 version 2004 ou plus récent nécessaire). Le flux reste sans son, jamais celui des autres fenêtres.`
      : "Son : uniquement celui de l'application de la fenêtre diffusée (pas celui des autres fenêtres).",
    system:
      "Son : celui de l'ordinateur (un écran entier n'est pas une seule fenêtre). Dans OBS, cochez « Contrôler l'audio via OBS » pour éviter l'écho.",
  };
  $("obs-audio-info").textContent = !info.audio
    ? "Flux sans son."
    : audioTexts[info.audioSource] ||
      (api.platform === "win32"
        ? "Son : uniquement celui du fichier ou de la fenêtre diffusés (celui de l'ordinateur pour un écran entier)."
        : "Son : celui des fichiers diffusés (onglet Fichiers). Sur ce système, le son d'une fenêtre ne peut pas être capturé.");
}

$("obs-quality").addEventListener("change", async () =>
  renderObs(await api.setObsQuality(Number($("obs-quality").value)))
);

$("obs-audio").addEventListener("change", async () =>
  renderObs(await api.setObsAudio($("obs-audio").checked))
);

document.querySelectorAll("[data-copy]").forEach((button) =>
  button.addEventListener("click", async () => {
    const text = $(button.dataset.copy).textContent;
    if (!text.startsWith("http")) return;
    await api.copyText(text);
    showToast("Adresse copiée : collez-la dans OBS.");
  })
);

api.onObs(renderObs);

// --- Démarrage -----------------------------------------------------------

async function init() {
  const settings = await api.getSettings();
  state.displayId = settings.displayId;
  state.fit = settings.fit;
  els.fit.value = state.fit;

  const permission = await api.screenPermission();
  els.banner.hidden = permission === "granted";

  await refreshDisplays();
  renderObs(await api.obsInfo());
  state.files = await api.listFiles();
  state.status = await api.getStatus();
  await refreshSources();
  renderStatus();

  // Les miniatures et la liste des fenêtres ouvertes se mettent à jour
  // toutes seules tant que l'application est visible.
  setInterval(() => {
    if (!document.hidden && !isFilesTab()) refreshSources();
  }, SOURCE_REFRESH_MS);
}

init();
