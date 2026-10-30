// Son d'une seule fenêtre (Windows) : lance windows/son-fenetre.ps1 et reçoit
// le son de l'application de cette fenêtre (PCM 16 bits, 48 kHz, stéréo).
const { spawn } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "windows", "son-fenetre.ps1");
const supported = process.platform === "win32";

let child = null;

function stop() {
  if (child) {
    const old = child;
    child = null;
    old.kill();
  }
}

// onData(Buffer) pour chaque morceau de son ; onError(message) si la capture
// est impossible (jamais de repli sur le son de tout l'ordinateur).
function start(hwnd, { onData, onError }) {
  stop();
  if (!supported) return onError("Uniquement sous Windows.");
  const proc = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Hwnd", String(hwnd)],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  child = proc;
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    if (child === proc) onData(chunk);
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (text) => (stderr += text));
  const fail = (message) => {
    if (child !== proc) return;
    child = null;
    onError(message);
  };
  proc.on("error", (error) => fail(error.message));
  proc.on("exit", () => fail(stderr.trim() || "Capture du son arrêtée."));
}

module.exports = { supported, start, stop };
