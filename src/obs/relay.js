// Fenêtre cachée qui fabrique le flux pour OBS : elle capture ce qui est
// diffusé, le compose en 1920×1080 (cadrage et zone recadrée compris) et
// envoie des images JPEG à l'application, qui les sert en MJPEG.
const api = window.diffusion;
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const FPS = 30;
const IDLE_INTERVAL_MS = 1000; // rien à diffuser : une image noire par seconde
const JPEG_QUALITY = 0.82;

let source = null; // { sourceId, fit, crop } ou null
let clients = 0;
let stream = null;
let streamFor = null;
let token = 0;
let running = false;

function stopCapture() {
  token++;
  window.stopStream(stream);
  stream = null;
  streamFor = null;
  video.srcObject = null;
}

// Capture seulement si OBS regarde et qu'il y a quelque chose à diffuser.
async function syncCapture() {
  const wanted = clients > 0 && source ? source.sourceId : null;
  if (wanted === streamFor) return;
  stopCapture();
  if (!wanted) return;
  const mine = token;
  streamFor = wanted;
  try {
    const next = await window.captureSource(wanted, {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: FPS,
    });
    if (mine !== token) return window.stopStream(next);
    stream = next;
    video.srcObject = next;
  } catch {
    if (mine === token) streamFor = null;
  }
}

function draw() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!source || !stream || !vw || !vh) return;
  const c = source.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = c.x * vw;
  const sy = c.y * vh;
  const sw = c.w * vw;
  const sh = c.h * vh;
  let dw = W;
  let dh = H;
  if (source.fit !== "fill") {
    const pick = source.fit === "cover" ? Math.max : Math.min;
    const scale = pick(W / sw, H / sh);
    dw = sw * scale;
    dh = sh * scale;
  }
  ctx.drawImage(video, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function encode() {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

// Une image à la fois : la suivante n'est préparée qu'une fois la
// précédente envoyée (pas d'accumulation si l'ordinateur est chargé).
async function loop() {
  if (running) return;
  running = true;
  while (clients > 0) {
    const started = performance.now();
    draw();
    const blob = await encode();
    if (blob && clients > 0) api.sendRelayFrame(await blob.arrayBuffer());
    const interval = source && stream ? 1000 / FPS : IDLE_INTERVAL_MS;
    const wait = Math.max(0, interval - (performance.now() - started));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  running = false;
}

api.onRelaySource((next) => {
  source = next;
  syncCapture();
});

api.onRelayClients((count) => {
  clients = count;
  syncCapture();
  if (clients > 0) loop();
});
