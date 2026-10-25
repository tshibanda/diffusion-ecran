// Capture vidéo d'une fenêtre ou d'un écran (identifiant fourni par
// desktopCapturer). Utilisé par l'aperçu et par la fenêtre de projection.
window.captureSource = function captureSource(sourceId, { maxWidth, maxHeight, maxFrameRate }) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth,
        maxHeight,
        maxFrameRate,
      },
    },
  });
};

window.stopStream = function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
};
