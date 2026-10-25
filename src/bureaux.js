// Bureaux virtuels de Windows : client de l'assistant PowerShell
// (windows/bureaux.ps1), lancé une seule fois et gardé ouvert.
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const SCRIPT = path.join(__dirname, "windows", "bureaux.ps1");
const REQUEST_TIMEOUT_MS = 10000;

const supported = process.platform === "win32";
let child = null;
let ready = null; // Promise<boolean>
let nextId = 1;
const pending = new Map();

function failAll(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

function start() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    readline.createInterface({ input: child.stdout }).on("line", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.replace(/^﻿/, ""));
      } catch {
        return;
      }
      if (message.ready) return resolve(true);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message.result);
    });

    const onEnd = () => {
      child = null;
      ready = null;
      resolve(false);
      failAll(new Error(stderr.trim() || "Assistant des bureaux arrêté."));
    };
    child.on("error", onEnd);
    child.on("exit", onEnd);
  });
  return ready;
}

async function request(message) {
  if (!supported) return { ok: false, error: "Uniquement sous Windows." };
  if (!(await start()) || !child) return { ok: false, error: "Assistant des bureaux indisponible." };
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Pas de réponse de l'assistant des bureaux."));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
  }).catch((error) => ({ ok: false, error: error.message }));
}

// Identifiant de fenêtre Windows (HWND) d'une BrowserWindow, en texte.
function hwndOf(win) {
  const handle = win.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

function stop() {
  if (child) child.kill();
}

module.exports = {
  supported,
  list: () => request({ cmd: "list", pid: process.pid }),
  // Uniquement pour nos propres fenêtres (écran de projection).
  pin: (hwnd) => request({ cmd: "pin", hwnd: String(hwnd) }),
  hwndOf,
  stop,
};
