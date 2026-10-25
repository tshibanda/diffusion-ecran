// Fenêtre cachée qui fabrique les flux pour OBS. Elle capture ce qui est
// diffusé, le compose en 1920×1080 (cadrage et zone recadrée compris) et :
//  - envoie des images JPEG (flux MJPEG, sans son) ;
//  - enregistre image + son en WebM (VP8 + Opus) pour le flux avec son,
//    un enregistreur par client OBS (chacun démarre ainsi sur une image clé).
const api = window.diffusion;
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const FPS = 30;
const IDLE_INTERVAL_MS = 1000; // rien à diffuser : une image noire par seconde
const JPEG_QUALITY = 0.82;
const WEBM_TYPE = "video/webm;codecs=vp8,opus";
const WEBM_TIMESLICE_MS = 100;
const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 160_000;
// Une image clé (et donc un nouveau bloc WebM) toutes les 0,5 s : un lecteur ne
// peut lire un bloc qu'une fois complet, c'est ce qui fixe le retard du flux.
const KEYFRAME_INTERVAL_MS = 500;

let source = null; // { sourceId, fit, crop } ou null
let clients = { mjpeg: 0, webm: 0 };
let stream = null;
let streamFor = null;
let token = 0;
let running = false;

const totalClients = () => clients.mjpeg + clients.webm;

// --- Image -------------------------------------------------------------------

function stopCapture() {
  token++;
  window.stopStream(stream);
  stream = null;
  streamFor = null;
  video.srcObject = null;
}

// Capture seulement si OBS regarde et qu'il y a quelque chose à diffuser.
async function syncCapture() {
  const wanted = totalClients() > 0 && source ? source.sourceId : null;
  if (wanted === streamFor) return;
  stopCapture();
  if (!wanted) return;
  const mine = token;
  streamFor = wanted;
  try {
    const next = await window.captureSource(wanted, {
      maxWidth: canvas.width,
      maxHeight: canvas.height,
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

function encodeJpeg() {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

// Une image à la fois : la suivante n'est préparée qu'une fois la
// précédente envoyée (pas d'accumulation si l'ordinateur est chargé).
async function loop() {
  if (running) return;
  running = true;
  while (totalClients() > 0) {
    const started = performance.now();
    draw();
    if (clients.webm > 0) pushVideoFrame(started);
    if (clients.mjpeg > 0) {
      const blob = await encodeJpeg();
      if (blob && clients.mjpeg > 0) api.sendRelayFrame(await blob.arrayBuffer());
    }
    // Le flux WebM a besoin d'images régulières même sans diffusion.
    const interval = (source && stream) || clients.webm > 0 ? 1000 / FPS : IDLE_INTERVAL_MS;
    const wait = Math.max(0, interval - (performance.now() - started));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  running = false;
}

// --- Son ---------------------------------------------------------------------
// Toujours une piste son (silencieuse si besoin) : changer de source sonore ne
// coupe pas les enregistreurs en cours.

const audioContext = new AudioContext({ sampleRate: 48000 });
const audioOut = audioContext.createMediaStreamDestination();
// Piste silencieuse permanente.
const silence = audioContext.createConstantSource();
silence.offset.value = 0;
silence.connect(audioOut);
silence.start();

let audioStream = null;
let audioNode = null;
let audioToken = 0;

function stopAudio() {
  audioToken++;
  if (audioNode) audioNode.disconnect();
  audioNode = null;
  window.stopStream(audioStream);
  audioStream = null;
}

// Appelé par l'application (avec un « geste utilisateur », nécessaire à
// getDisplayMedia) ; c'est elle qui choisit la source sonore.
window.__relayAudio = async (enabled) => {
  stopAudio();
  if (!enabled) return false;
  const mine = audioToken;
  try {
    const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // Seul le son nous intéresse : l'image fournie avec est aussitôt arrêtée.
    captured.getVideoTracks().forEach((t) => t.stop());
    const [track] = captured.getAudioTracks();
    if (mine !== audioToken || !track) {
      window.stopStream(captured);
      return false;
    }
    audioStream = captured;
    audioNode = audioContext.createMediaStreamSource(new MediaStream([track]));
    audioNode.connect(audioOut);
    await audioContext.resume();
    return true;
  } catch {
    return false;
  }
};

// --- Flux WebM (image + son) ---------------------------------------------------
// Chaque image dessinée est remise explicitement à l'enregistreur : une
// fenêtre cachée n'est presque jamais repeinte, et canvas.captureStream() n'y
// produirait que quelques images par seconde.

const videoTrack = new MediaStreamTrackGenerator({ kind: "video" });
const videoWriter = videoTrack.writable.getWriter();
let writing = false;

function pushVideoFrame(timeMs) {
  if (writing) return; // l'image précédente n'est pas encore prise : on saute
  writing = true;
  const frame = new VideoFrame(canvas, { timestamp: Math.round(timeMs * 1000) });
  videoWriter
    .write(frame)
    .catch(() => frame.close())
    .finally(() => (writing = false));
}

const outStream = new MediaStream([videoTrack, ...audioOut.stream.getAudioTracks()]);
const recorders = new Map();

function startRecorder(id) {
  if (recorders.has(id)) return;
  const recorder = new MediaRecorder(outStream, {
    mimeType: WEBM_TYPE,
    videoBitsPerSecond: canvas.height === 720 ? VIDEO_BITRATE / 2 : VIDEO_BITRATE,
    audioBitsPerSecond: AUDIO_BITRATE,
    videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS,
  });
  recorder.ondataavailable = async (event) => {
    if (event.data && event.data.size > 0 && recorders.get(id) === recorder) {
      api.sendRelayChunk(id, await event.data.arrayBuffer());
    }
  };
  recorders.set(id, recorder);
  audioContext.resume();
  recorder.start(WEBM_TIMESLICE_MS);
}

function stopRecorder(id) {
  const recorder = recorders.get(id);
  recorders.delete(id);
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

// --- Messages de l'application ------------------------------------------------

// Qualité du flux : 1080p (par défaut) ou 720p, plus léger pour l'ordinateur.
api.onRelayQuality((height) => {
  const h = height === 720 ? 720 : 1080;
  if (canvas.height === h) return;
  canvas.width = Math.round((h * 16) / 9);
  canvas.height = h;
  // La capture repart à la bonne taille (les clients OBS se reconnectent).
  stopCapture();
  syncCapture();
});

api.onRelaySource((next) => {
  source = next;
  syncCapture();
});

api.onRelayClients((count) => {
  clients = count;
  syncCapture();
  if (totalClients() > 0) loop();
});

api.onRelayRecorder(({ id, start }) => (start ? startRecorder(id) : stopRecorder(id)));
