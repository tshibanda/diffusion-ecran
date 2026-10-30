// Fenêtre cachée qui fabrique les flux pour OBS. Elle capture ce qui est
// diffusé, le compose (cadrage et zone recadrée compris) à 60 images par
// seconde et :
//  - envoie des images JPEG (flux MJPEG, sans son) ;
//  - enregistre image + son (H.264 en MP4, ou VP8 en WebM) pour le flux avec
//    son, un enregistreur par client OBS (chacun démarre sur une image clé).
const api = window.diffusion;
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const IDLE_INTERVAL_MS = 1000; // MJPEG seul, rien à diffuser : une image par seconde
const JPEG_QUALITY = 0.9;
const TIMESLICE_MS = 100;
const AUDIO_BITRATE = 192_000;
// Débit vidéo : local à l'ordinateur, on peut être généreux.
const VIDEO_BITRATE = { 1080: 20_000_000, 720: 10_000_000 };
// Une image clé (et donc un nouveau bloc) toutes les 0,5 s : un lecteur ne peut
// lire un bloc qu'une fois complet, c'est ce qui fixe le retard du flux.
const KEYFRAME_INTERVAL_MS = 500;
// H.264 : encodé par la carte graphique quand elle le permet (Windows, Mac).
const FORMATS = {
  mp4: "video/mp4;codecs=avc1.64002A,opus",
  webm: "video/webm;codecs=vp8,opus",
};

let source = null; // { sourceId, fit, crop } ou null
let clients = { mjpeg: 0, webm: 0 };
const totalClients = () => clients.mjpeg + clients.webm;

ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

// --- Capture -------------------------------------------------------------------
// Les images sont lues directement sur la piste capturée (sans passer par un
// lecteur vidéo, presque jamais repeint dans une fenêtre cachée).

let stream = null;
let captureKey = null;
let token = 0;
let latest = null; // dernière image reçue (VideoFrame)
let latestIsNew = false;

function setLatest(frame) {
  if (latest) latest.close();
  latest = frame;
  latestIsNew = !!frame;
}

function stopCapture() {
  token++;
  window.stopStream(stream);
  stream = null;
  captureKey = null;
  setLatest(null);
}

// Taille de capture : celle de la sortie, agrandie pour une zone recadrée
// (la partie gardée reste nette une fois mise en plein cadre).
function captureSize() {
  const c = (source && source.crop) || { w: 1, h: 1 };
  return {
    maxWidth: Math.min(3840, Math.round(canvas.width / Math.max(c.w, 0.05))),
    maxHeight: Math.min(2160, Math.round(canvas.height / Math.max(c.h, 0.05))),
  };
}

// Capture seulement si OBS regarde et qu'il y a quelque chose à diffuser.
async function syncCapture() {
  const size = captureSize();
  const wanted =
    totalClients() > 0 && source ? `${source.sourceId}|${size.maxWidth}x${size.maxHeight}` : null;
  if (wanted === captureKey) return;
  stopCapture();
  if (!wanted) return;
  const mine = token;
  captureKey = wanted;
  try {
    const next = await window.captureSource(source.sourceId, { ...size, maxFrameRate: FPS });
    if (mine !== token) return window.stopStream(next);
    stream = next;
    const [track] = next.getVideoTracks();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || mine !== token) {
        if (value) value.close();
        break;
      }
      setLatest(value);
    }
  } catch {
    if (mine === token) captureKey = null;
  }
}

// --- Composition ---------------------------------------------------------------

function draw() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!source || !latest) return;
  const vw = latest.displayWidth;
  const vh = latest.displayHeight;
  if (!vw || !vh) return;
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
  ctx.drawImage(latest, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// --- Image seule (MJPEG) -------------------------------------------------------

let jpegBusy = false;
let lastJpeg = 0;

function pushJpeg(now) {
  // Une image à la fois ; si l'encodage est plus lent, on en saute.
  if (jpegBusy) return;
  const idle = !(source && latest);
  if (idle && now - lastJpeg < IDLE_INTERVAL_MS) return;
  jpegBusy = true;
  lastJpeg = now;
  canvas.toBlob(
    async (blob) => {
      if (blob && clients.mjpeg > 0) api.sendRelayFrame(await blob.arrayBuffer());
      jpegBusy = false;
    },
    "image/jpeg",
    JPEG_QUALITY
  );
}

// --- Image + son (MP4 / WebM) ----------------------------------------------------

const videoTrack = new MediaStreamTrackGenerator({ kind: "video" });
// Vidéo en mouvement : l'encodeur garde la fluidité plutôt que la définition.
videoTrack.contentHint = "motion";
const videoWriter = videoTrack.writable.getWriter();
let writing = false;

function pushVideoFrame(now) {
  if (writing) return; // l'image précédente n'est pas encore prise : on saute
  writing = true;
  const frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1000) });
  videoWriter
    .write(frame)
    .catch(() => frame.close())
    .finally(() => (writing = false));
}

// --- Cadence : 60 images par seconde, régulières ---------------------------------

let running = false;

async function loop() {
  if (running) return;
  running = true;
  let next = performance.now();
  while (totalClients() > 0) {
    const now = performance.now();
    // L'image n'est recomposée que si une nouvelle est arrivée ou si rien n'est
    // affiché ; sinon la précédente est simplement renvoyée (écran immobile).
    if (latestIsNew || !latest) {
      draw();
      latestIsNew = false;
    }
    if (clients.webm > 0) pushVideoFrame(now);
    if (clients.mjpeg > 0) pushJpeg(now);
    next += FRAME_MS;
    // En retard (ordinateur chargé) : on repart de maintenant sans rattraper.
    if (next < performance.now()) next = performance.now() + FRAME_MS;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - performance.now())));
  }
  running = false;
}

// --- Son ---------------------------------------------------------------------------
// Toujours une piste son (silencieuse si besoin) : changer de source sonore ne
// coupe pas les enregistreurs en cours.

const audioContext = new AudioContext({ sampleRate: 48000 });
const audioOut = audioContext.createMediaStreamDestination();
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

// --- Enregistreurs ------------------------------------------------------------------

const outStream = new MediaStream([videoTrack, ...audioOut.stream.getAudioTracks()]);
const recorders = new Map();

function startRecorder(id, format) {
  if (recorders.has(id)) return;
  const wanted = FORMATS[format] || FORMATS.mp4;
  const mimeType = MediaRecorder.isTypeSupported(wanted) ? wanted : FORMATS.webm;
  const recorder = new MediaRecorder(outStream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITRATE[canvas.height] || VIDEO_BITRATE[1080],
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
  recorder.start(TIMESLICE_MS);
}

function stopRecorder(id) {
  const recorder = recorders.get(id);
  recorders.delete(id);
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

// --- Messages de l'application --------------------------------------------------------

// Qualité du flux : 1080p (par défaut) ou 720p, plus léger pour l'ordinateur.
api.onRelayQuality((height) => {
  const h = height === 720 ? 720 : 1080;
  if (canvas.height === h) return;
  canvas.width = Math.round((h * 16) / 9);
  canvas.height = h;
  ctx.imageSmoothingQuality = "high";
  latestIsNew = true;
  // La capture repart à la bonne taille (les clients OBS se reconnectent).
  stopCapture();
  syncCapture();
});

api.onRelaySource((next) => {
  source = next;
  latestIsNew = true;
  syncCapture();
});

api.onRelayClients((count) => {
  clients = count;
  syncCapture();
  if (totalClients() > 0) loop();
});

api.onRelayRecorder(({ id, start, format }) => (start ? startRecorder(id, format) : stopRecorder(id)));
