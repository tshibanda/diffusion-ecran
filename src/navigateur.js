// « Chrome de diffusion » : une instance séparée de Chrome (ou Edge) qui
// continue de dessiner sa page même quand sa fenêtre n'est pas visible.
//
// Un Chrome normal arrête de dessiner (et coupe la vidéo) dès que sa fenêtre
// est sur un autre bureau virtuel ou entièrement cachée : la capture ne reçoit
// alors qu'une image figée et noire. Ces économies ne se désactivent qu'au
// lancement de Chrome, d'où cette instance à part, avec son propre profil
// (le Chrome habituel n'est pas touché ; les connexions faites ici restent).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const FLAGS = [
  // Ne pas considérer la fenêtre comme cachée (autre bureau, recouverte).
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  // Vidéo dessinée dans la fenêtre plutôt que confiée à la carte graphique.
  "--disable-direct-composition-video-overlays",
  "--no-first-run",
  "--no-default-browser-check",
];

function candidates() {
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return [
      ...roots.map((r) => ({ name: "Chrome", file: path.join(r, "Google", "Chrome", "Application", "chrome.exe") })),
      ...roots.map((r) => ({ name: "Edge", file: path.join(r, "Microsoft", "Edge", "Application", "msedge.exe") })),
    ];
  }
  if (process.platform === "darwin") {
    return [
      { name: "Chrome", file: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Edge", file: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ];
  }
  return [
    { name: "Chrome", file: "/usr/bin/google-chrome" },
    { name: "Chromium", file: "/usr/bin/chromium" },
  ];
}

function findBrowser() {
  return candidates().find((c) => fs.existsSync(c.file)) || null;
}

function openDiffusionBrowser(profileDir, url) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "Google Chrome (ou Edge) est introuvable sur cet ordinateur." };
  const args = [`--user-data-dir=${profileDir}`, ...FLAGS, url || "https://www.youtube.com"];
  try {
    spawn(browser.file, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, browser: browser.name };
}

module.exports = { openDiffusionBrowser };
