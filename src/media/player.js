// Écran de projection pour les fichiers : vidéo, son, image, ou diapositives
// (PDF, ou présentation convertie en images). Piloté depuis la régie.
import * as pdfjs from "../../node_modules/pdfjs-dist/build/pdf.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../../node_modules/pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;

const api = window.diffusion;
const video = document.getElementById("video");
const image = document.getElementById("image");
const canvas = document.getElementById("page");
const STATE_INTERVAL_MS = 250;

let file = null; // fichier affiché (voir fichiers.js : describe)
let slides = null; // { count, show(index) }
let index = 0;
let token = 0;

function showOnly(element) {
  for (const e of [video, image, canvas]) e.hidden = e !== element;
}

function stopVideo() {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

// --- État envoyé à la régie ------------------------------------------------------

function sendState() {
  if (!file) return;
  if (slides) {
    api.sendMediaState({ type: "slides", index, count: slides.count, name: file.name });
  } else if (file.type === "video" || file.type === "audio") {
    api.sendMediaState({
      type: "media",
      paused: video.paused,
      ended: video.ended,
      time: video.currentTime || 0,
      duration: isFinite(video.duration) ? video.duration : 0,
      volume: Math.round(video.volume * 100),
      muted: video.muted,
      loop: video.loop,
      name: file.name,
    });
  } else {
    api.sendMediaState({ type: "image", name: file.name });
  }
}
setInterval(() => {
  if (file && !slides && (file.type === "video" || file.type === "audio")) sendState();
}, STATE_INTERVAL_MS);

// --- Diapositives ----------------------------------------------------------------

// PDF : chaque page est dessinée à la taille exacte de l'écran (net, quelle
// que soit la définition), d'abord hors écran pour éviter tout clignotement.
async function pdfSlides(mine) {
  const data = await api.readSlidesPdf();
  const doc = await pdfjs.getDocument({ data }).promise;
  const cache = new Map(); // index -> canvas déjà dessiné

  async function render(i) {
    if (cache.has(i)) return cache.get(i);
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(window.innerWidth / base.width, window.innerHeight / base.height) * dpr;
    const viewport = page.getViewport({ scale });
    const off = document.createElement("canvas");
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    await page.render({ canvas: off, canvasContext: off.getContext("2d"), viewport }).promise;
    cache.set(i, off);
    // Garde seulement les pages proches en mémoire.
    for (const k of cache.keys()) if (Math.abs(k - i) > 2) cache.delete(k);
    return off;
  }

  return {
    count: doc.numPages,
    async show(i) {
      const off = await render(i);
      if (mine !== token || i !== index) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.style.width = `${off.width / dpr}px`;
      canvas.style.height = `${off.height / dpr}px`;
      canvas.getContext("2d").drawImage(off, 0, 0);
      showOnly(canvas);
      // Prépare la suivante pour un passage instantané.
      if (i + 1 < doc.numPages) render(i + 1).catch(() => {});
    },
    reset: () => cache.clear(),
  };
}

function imageSlides(urls) {
  return {
    count: urls.length,
    show(i) {
      image.src = urls[i];
      showOnly(image);
      // Précharge la suivante.
      if (urls[i + 1]) new Image().src = urls[i + 1];
    },
  };
}

async function goTo(i) {
  if (!slides) return;
  index = Math.max(0, Math.min(slides.count - 1, i));
  sendState();
  try {
    await slides.show(index);
  } catch {
    // Page illisible : on reste sur la précédente.
  }
}

// --- Chargement d'un fichier -------------------------------------------------------

async function load(live) {
  if (!live || !live.file) return;
  document.body.className = `fit-${live.fit || "contain"}`;
  // Même fichier (changement de cadrage…) : rien à recharger.
  if (file && file.path === live.file.path) return;

  const mine = ++token;
  file = live.file;
  slides = null;
  index = 0;
  stopVideo();
  image.removeAttribute("src");

  try {
    if (file.type === "video" || file.type === "audio") {
      video.loop = false;
      video.src = file.url;
      // Un son seul : écran noir.
      showOnly(file.type === "video" ? video : null);
      await video.play();
    } else if (file.type === "image") {
      image.src = file.url;
      showOnly(image);
    } else if (file.slides) {
      const next =
        file.slides.kind === "pdf" ? await pdfSlides(mine) : imageSlides(file.slides.images);
      if (mine !== token) return;
      slides = next;
      await goTo(live.slide || 0);
    }
  } catch (error) {
    if (mine === token && !(error && error.name === "AbortError")) {
      api.reportMediaError(error && error.message ? error.message : String(error));
    }
  }
  sendState();
}

video.addEventListener("error", () => {
  if (file) api.reportMediaError("format non pris en charge");
});
video.addEventListener("ended", sendState);

window.addEventListener("resize", () => {
  if (slides && slides.reset) {
    slides.reset();
    goTo(index);
  }
});

// --- Télécommande ---------------------------------------------------------------------

api.onMediaCommand(({ action, value }) => {
  switch (action) {
    case "toggle":
      if (video.paused || video.ended) video.play().catch(() => {});
      else video.pause();
      break;
    case "seek-by":
      video.currentTime = Math.max(0, video.currentTime + value);
      break;
    case "seek-to":
      video.currentTime = value;
      break;
    case "volume":
      video.volume = Math.max(0, Math.min(1, value / 100));
      if (value > 0) video.muted = false;
      break;
    case "mute":
      video.muted = !video.muted;
      break;
    case "loop":
      video.loop = !!value;
      break;
    case "next":
      goTo(index + 1);
      return;
    case "prev":
      goTo(index - 1);
      return;
    case "goto":
      goTo(value);
      return;
  }
  sendState();
});

api.onSource(load);
api.getCurrent().then(load);
