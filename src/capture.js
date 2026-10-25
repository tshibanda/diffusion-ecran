// Capture vidéo d'une fenêtre ou d'un écran (identifiant fourni par
// desktopCapturer). Utilisé par l'aperçu et par la fenêtre de projection.
window.captureSource = async function captureSource(
  sourceId,
  { maxWidth, maxHeight, maxFrameRate }
) {
  // Au démarrage de la capture d'une fenêtre, Chromium la met au premier
  // plan (ce qui ferait changer de bureau virtuel) : on l'en empêche.
  const guard = sourceId.startsWith("window:") && window.diffusion.holdForeground;
  if (guard) await window.diffusion.holdForeground(true);
  try {
    return await navigator.mediaDevices.getUserMedia({
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
  } finally {
    if (guard) window.diffusion.holdForeground(false);
  }
};

window.stopStream = function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
};
