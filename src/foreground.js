// Windows : au démarrage de la capture d'une fenêtre, Chromium la met au
// premier plan. Si elle est sur un autre bureau virtuel, Windows bascule
// alors sur ce bureau. On bloque donc tout passage au premier plan le temps
// que la capture démarre (LockSetForegroundWindow, appelé par l'application
// elle-même car seule l'application au premier plan peut le faire).
const LSFW_LOCK = 1;
const LSFW_UNLOCK = 2;
// Filet de sécurité : jamais bloqué plus longtemps que ça.
const MAX_LOCK_MS = 5000;
// Marge après le démarrage de la capture avant de débloquer.
const RELEASE_DELAY_MS = 250;

let lockSetForegroundWindow; // undefined = pas encore chargé, null = indisponible
let holders = 0;
let safetyTimer = null;

function nativeLock() {
  if (lockSetForegroundWindow !== undefined) return lockSetForegroundWindow;
  lockSetForegroundWindow = null;
  if (process.platform !== "win32") return null;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    lockSetForegroundWindow = user32.func("__stdcall", "LockSetForegroundWindow", "bool", ["uint32"]);
  } catch {
    // Sans koffi, la capture fonctionne mais peut changer de bureau.
  }
  return lockSetForegroundWindow;
}

function release() {
  holders = 0;
  clearTimeout(safetyTimer);
  safetyTimer = null;
  const lock = nativeLock();
  if (lock) lock(LSFW_UNLOCK);
}

function hold() {
  const lock = nativeLock();
  if (!lock) return;
  holders++;
  lock(LSFW_LOCK);
  clearTimeout(safetyTimer);
  safetyTimer = setTimeout(release, MAX_LOCK_MS);
}

function unhold() {
  if (holders === 0) return;
  setTimeout(() => {
    holders = Math.max(0, holders - 1);
    if (holders === 0) release();
  }, RELEASE_DELAY_MS);
}

module.exports = { hold, unhold };
