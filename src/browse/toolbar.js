// Barre de la fenêtre « Parcourir YouTube » : navigation et envoi de la
// vidéo affichée vers l'écran de projection.
const api = window.diffusion;
const $ = (id) => document.getElementById(id);

$("back").addEventListener("click", () => api.browseNav("back"));
$("forward").addEventListener("click", () => api.browseNav("forward"));
$("reload").addEventListener("click", () => api.browseNav("reload"));
$("home").addEventListener("click", () => api.browseNav("home"));
$("stop").addEventListener("click", () => api.stop());
$("diffuse").addEventListener("click", async () => {
  $("diffuse").disabled = true;
  await api.browseDiffuse();
});

api.onBrowseState((s) => {
  $("back").disabled = !s.canGoBack;
  $("forward").disabled = !s.canGoForward;
  $("title").textContent = s.title || s.url || "";
  $("title").title = s.url || "";
  $("diffuse").disabled = !s.isVideo;
  $("diffuse").title = s.isVideo
    ? "Envoie cette vidéo en plein écran sur l'écran de projection, au moment où vous êtes"
    : "Ouvrez une vidéo pour pouvoir la diffuser";
  $("live").hidden = !s.live;
  $("live").textContent = s.live ? `● En direct : ${s.liveName}` : "";
  $("stop").hidden = !s.live;
});
