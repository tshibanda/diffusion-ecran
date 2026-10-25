const api = window.diffusion;
const frame = document.getElementById("frame");
const video = document.getElementById("video");

let stream = null;
let currentSourceId = null;
let fit = "contain";
let crop = null; // { x, y, w, h } en fractions de l'image, ou null = image entière
// Incrémenté à chaque demande : une capture lente qui arrive après une
// demande plus récente est simplement jetée.
let requestToken = 0;

// Place la vidéo pour que la zone choisie remplisse l'écran selon le cadrage.
function layout() {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H) return;
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const cropW = c.w * W;
  const cropH = c.h * H;
  const VW = window.innerWidth;
  const VH = window.innerHeight;

  let sx;
  let sy;
  if (fit === "fill") {
    sx = VW / cropW;
    sy = VH / cropH;
  } else {
    const pick = fit === "cover" ? Math.max : Math.min;
    sx = sy = pick(VW / cropW, VH / cropH);
  }
  const frameW = cropW * sx;
  const frameH = cropH * sy;
  Object.assign(frame.style, {
    left: `${(VW - frameW) / 2}px`,
    top: `${(VH - frameH) / 2}px`,
    width: `${frameW}px`,
    height: `${frameH}px`,
  });
  Object.assign(video.style, {
    left: `${-c.x * W * sx}px`,
    top: `${-c.y * H * sy}px`,
    width: `${W * sx}px`,
    height: `${H * sy}px`,
  });
}

async function show(live) {
  if (!live) return;
  fit = live.fit;
  crop = live.crop || null;
  layout();
  if (live.sourceId === currentSourceId && stream) return;

  const token = ++requestToken;
  let next;
  try {
    next = await window.captureSource(live.sourceId, {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFrameRate: 60,
    });
  } catch {
    if (token === requestToken) api.reportEnded("capture-failed");
    return;
  }
  if (token !== requestToken) {
    window.stopStream(next);
    return;
  }

  // On remplace l'image seulement quand la nouvelle est prête : pas de noir
  // entre deux fenêtres.
  const previous = stream;
  stream = next;
  currentSourceId = live.sourceId;
  video.srcObject = next;
  window.stopStream(previous);

  const [track] = next.getVideoTracks();
  if (track) {
    track.addEventListener("ended", () => {
      if (stream === next) api.reportEnded("source-closed");
    });
  }
}

// "resize" sur la vidéo : la fenêtre capturée a changé de taille.
video.addEventListener("loadedmetadata", layout);
video.addEventListener("resize", layout);
window.addEventListener("resize", layout);

api.onSource(show);
// L'application intercepte déjà Échap ; ceci n'est qu'une sécurité.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") api.requestStop();
});
api.getCurrent().then(show);

window.addEventListener("beforeunload", () => window.stopStream(stream));
