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
// Une image clé (et donc un nouveau bloc) toutes les 0,5 s : un lecteur ne
// peut lire un bloc qu'une fois complet, c'est ce qui fixe le retard du flux.
const KEYFRAME_INTERVAL_MS = 500;
// H.264 : encodé par la carte graphique quand elle le permet (Windows, Mac).
const FORMATS = {
  mp4: "video/mp4;codecs=avc1.64002A,opus",
  webm: "video/webm;codecs=vp8,opus",
};

let source = null; // { sourceId, fit, crop } ou null
let clients = { mjpeg: 0, webm: 0, direct: 0 };
const totalClients = () => clients.mjpeg + clients.webm + clients.direct;

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

// Horodatage sur une grille régulière de 60 i/s (et non l'heure exacte de
// production, irrégulière dans une fenêtre cachée) : le mouvement reste fluide.
let gridStart = null;
let lastSlot = -1;

function gridTimestamp(now) {
  if (gridStart === null) gridStart = now;
  const slot = Math.max(lastSlot + 1, Math.round((now - gridStart) / FRAME_MS));
  lastSlot = slot;
  return Math.round((gridStart + slot * FRAME_MS) * 1000);
}

function pushVideoFrame(timestamp) {
  if (writing) return; // l'image précédente n'est pas encore prise : on saute
  writing = true;
  const frame = new VideoFrame(canvas, { timestamp });
  videoWriter
    .write(frame)
    .catch(() => frame.close())
    .finally(() => (writing = false));
}

// --- Cadence : 60 images par seconde, régulières ---------------------------------

let running = false;

// Image immobile : renvoyée quand même de temps en temps pour que le flux
// continue (sans dupliquer inutilement chaque image, ce qui doublerait le
// travail d'encodage et de décodage pour une source à 30 i/s).
const REPEAT_MS = 100;

async function loop() {
  if (running) return;
  running = true;
  let next = performance.now();
  let lastPushed = -Infinity;
  while (totalClients() > 0) {
    const now = performance.now();
    // Une nouvelle image est envoyée dès qu'elle arrive (jusqu'à 60 i/s).
    const fresh = latestIsNew;
    if (fresh || !latest) {
      draw();
      latestIsNew = false;
    }
    if (fresh || now - lastPushed >= REPEAT_MS) {
      const timestamp = gridTimestamp(now);
      if (clients.webm > 0) pushVideoFrame(timestamp);
      if (clients.direct > 0) encodeDirect(timestamp);
      if (clients.mjpeg > 0) pushJpeg(now);
      lastPushed = now;
    }
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

// Son d'une seule fenêtre (Windows) : reçu en continu de l'application
// (voir son-fenetre.js) et joué dans le flux par pcm-worklet.js.
let pcmNode = null;
let pcmOn = false;

async function setPcmMode(on) {
  pcmOn = on;
  if (on) {
    stopAudio();
    if (!pcmNode) {
      await audioContext.audioWorklet.addModule("pcm-worklet.js");
      pcmNode = new AudioWorkletNode(audioContext, "pcm-player", { outputChannelCount: [2] });
    }
    if (pcmOn) pcmNode.connect(audioOut);
    audioContext.resume();
  } else if (pcmNode) {
    pcmNode.disconnect();
  }
}

api.onRelayPcmMode((on) => setPcmMode(on));

api.onRelayPcm((bytes) => {
  if (!pcmOn || !pcmNode) return;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  pcmNode.port.postMessage(samples, [samples.buffer]);
});

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

// --- Flux direct pour la page d'OBS (WebCodecs) ----------------------------------------
// Chaque image est encodée tout de suite (H.264 par la carte graphique quand
// c'est possible, sinon VP8) et envoyée telle quelle ; la page la décode et
// l'affiche aussitôt, à son rythme. Pas de mise en mémoire tampon par blocs
// (MSE), qui fait sauter des images en direct. Le son suit le même chemin (Opus).

const DIRECT_KEYFRAME_MS = 2000;
let videoEncoder = null;
let videoEncoderSize = null;
let needKeyframe = true;
let lastKeyframe = 0;

async function ensureVideoEncoder() {
  const size = `${canvas.width}x${canvas.height}`;
  if (videoEncoder && videoEncoder.state === "configured" && videoEncoderSize === size) return;
  if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
  videoEncoder = null;
  const base = {
    width: canvas.width,
    height: canvas.height,
    bitrate: VIDEO_BITRATE[canvas.height] || VIDEO_BITRATE[1080],
    framerate: FPS,
    latencyMode: "realtime",
  };
  const candidates = [
    { ...base, codec: "avc1.64002A", avc: { format: "annexb" } },
    { ...base, codec: "vp8" },
  ];
  let config = null;
  for (const candidate of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported(candidate)).supported) {
        config = candidate;
        break;
      }
    } catch {
      // Essai suivant.
    }
  }
  if (!config) return;
  const encoder = new VideoEncoder({
    output: (chunk) => sendDirectChunk("video", chunk),
    error: () => {
      if (videoEncoder === encoder) videoEncoder = null;
    },
  });
  encoder.configure(config);
  videoEncoder = encoder;
  videoEncoderSize = size;
  needKeyframe = true;
  api.sendDirect({ kind: "video-config", config: { codec: config.codec, width: config.width, height: config.height } });
}

let encoderStarting = null;
function encodeDirect(timestamp) {
  const sizeChanged = videoEncoderSize !== `${canvas.width}x${canvas.height}`;
  if (!videoEncoder || videoEncoder.state !== "configured" || sizeChanged) {
    if (!encoderStarting) encoderStarting = ensureVideoEncoder().finally(() => (encoderStarting = null));
    return;
  }
  // Encodeur en retard : on saute l'image plutôt que d'accumuler du retard.
  if (videoEncoder.encodeQueueSize > 2) return;
  const now = performance.now();
  const keyFrame = needKeyframe || now - lastKeyframe >= DIRECT_KEYFRAME_MS;
  if (keyFrame) {
    needKeyframe = false;
    lastKeyframe = now;
  }
  const frame = new VideoFrame(canvas, { timestamp });
  videoEncoder.encode(frame, { keyFrame });
  frame.close();
}

function sendDirectChunk(kind, chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  api.sendDirect({ kind, key: chunk.type === "key", timestamp: chunk.timestamp, data });
}

let audioEncoder = null;
let audioEncoderToken = 0;

async function startAudioEncoder() {
  if (audioEncoder) return;
  const mine = ++audioEncoderToken;
  const config = { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: AUDIO_BITRATE };
  const encoder = new AudioEncoder({ output: (chunk) => sendDirectChunk("audio", chunk), error: () => {} });
  encoder.configure(config);
  audioEncoder = encoder;
  api.sendDirect({ kind: "audio-config", config: { codec: "opus", sampleRate: 48000, numberOfChannels: 2 } });
  const track = audioOut.stream.getAudioTracks()[0].clone();
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  audioContext.resume();
  for (;;) {
    const { value, done } = await reader.read();
    if (done || mine !== audioEncoderToken) {
      if (value) value.close();
      break;
    }
    if (encoder.state === "configured") encoder.encode(value);
    value.close();
  }
  track.stop();
}

function stopDirect() {
  audioEncoderToken++;
  if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
  audioEncoder = null;
  if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
  videoEncoder = null;
}

// Nouveau client OBS : il doit commencer par une image clé.
api.onRelayKeyframe(() => (needKeyframe = true));

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
  clients = { mjpeg: 0, webm: 0, direct: 0, ...count };
  if (clients.direct > 0) {
    startAudioEncoder();
    needKeyframe = true;
  } else {
    stopDirect();
  }
  syncCapture();
  if (totalClients() > 0) loop();
});

api.onRelayRecorder(({ id, start, format }) => (start ? startRecorder(id, format) : stopRecorder(id)));
