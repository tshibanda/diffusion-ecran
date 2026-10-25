const api = window.diffusion;
const video = document.getElementById("video");

let stream = null;
let currentSourceId = null;
// Incrémenté à chaque demande : une capture lente qui arrive après une
// demande plus récente est simplement jetée.
let requestToken = 0;

function applyFit(fit) {
  video.classList.toggle("fit-cover", fit === "cover");
  video.classList.toggle("fit-fill", fit === "fill");
}

async function show(live) {
  if (!live) return;
  applyFit(live.fit);
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

api.onSource(show);
api.getCurrent().then(show);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") api.requestStop();
});

window.addEventListener("beforeunload", () => window.stopStream(stream));
