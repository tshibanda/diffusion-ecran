// Fichiers à diffuser : vidéos, sons, images, PDF et présentations.
//
// Les présentations (PowerPoint, LibreOffice…) ne peuvent pas être affichées
// directement : chaque diapositive est convertie en image, une fois pour toutes
// (cache), avec PowerPoint s'il est installé (Windows), sinon LibreOffice
// (converti en PDF). Les animations à l'intérieur des diapositives sont perdues.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const TYPES = {
  video: ["mp4", "m4v", "mov", "webm", "mkv", "ogv"],
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"],
  pdf: ["pdf"],
  presentation: ["pptx", "ppt", "ppsx", "pps", "pptm", "odp"],
};
const CONVERSION_TIMEOUT_MS = 5 * 60 * 1000;

const DIALOG_FILTERS = [
  { name: "Fichiers pris en charge", extensions: Object.values(TYPES).flat() },
  { name: "Vidéos", extensions: TYPES.video },
  { name: "Sons", extensions: TYPES.audio },
  { name: "Images", extensions: TYPES.image },
  { name: "PDF et présentations", extensions: [...TYPES.pdf, ...TYPES.presentation] },
];

function typeOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(TYPES).find((type) => TYPES[type].includes(ext)) || null;
}

// Description envoyée à la régie (null si le fichier est absent ou non pris en charge).
function describe(file) {
  const type = typeOf(file);
  if (!type) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { path: file, name: path.basename(file), type, url: pathToFileURL(file).href };
}

// --- Conversion des présentations --------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), CONVERSION_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `code ${code}`));
    });
  });
}

function findLibreOffice() {
  const candidates =
    process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]
          .filter(Boolean)
          .map((root) => path.join(root, "LibreOffice", "program", "soffice.exe"))
      : process.platform === "darwin"
        ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
        : ["/usr/bin/soffice", "/usr/local/bin/soffice", "/usr/bin/libreoffice"];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

// PowerPoint (Windows) : une image PNG par diapositive visible.
async function convertWithPowerPoint(file, outDir) {
  const script = path.join(__dirname, "windows", "convertir-presentation.ps1");
  const out = await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Fichier",
    file,
    "-Dossier",
    outDir,
  ]);
  const count = parseInt(out.trim().split(/\s+/).pop(), 10);
  if (!count) throw new Error("Aucune diapositive exportée.");
  const images = Array.from({ length: count }, (_, i) => path.join(outDir, `${i + 1}.png`));
  return { kind: "images", images: images.map((f) => pathToFileURL(f).href) };
}

// LibreOffice (Windows, Mac, Linux) : conversion en PDF.
async function convertWithLibreOffice(soffice, file, outDir, profileDir) {
  await run(soffice, [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir,
    file,
  ]);
  const pdf = path.join(outDir, `${path.parse(file).name}.pdf`);
  if (!fs.existsSync(pdf)) throw new Error("LibreOffice n'a pas produit de PDF.");
  return { kind: "pdf", pdf };
}

const pending = new Map(); // conversions en cours (un même fichier n'est converti qu'une fois)

// Prépare un fichier pour la diffusion. Pour un PDF ou une présentation,
// renvoie les diapositives : { kind: "pdf", pdf } ou { kind: "images", images }.
function prepare(item, cacheRoot) {
  if (item.type === "pdf") return Promise.resolve({ kind: "pdf", pdf: item.path });
  if (item.type !== "presentation") return Promise.resolve(null);

  const stat = fs.statSync(item.path);
  const key = crypto
    .createHash("sha1")
    .update(`${item.path}|${stat.size}|${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  if (pending.has(key)) return pending.get(key);

  const outDir = path.join(cacheRoot, "conversions", key);
  const doneFile = path.join(outDir, "diapositives.json");
  const task = (async () => {
    try {
      return JSON.parse(fs.readFileSync(doneFile, "utf8"));
    } catch {
      // Pas encore converti.
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    let slides = null;
    const errors = [];
    if (process.platform === "win32") {
      try {
        slides = await convertWithPowerPoint(item.path, outDir);
      } catch (error) {
        errors.push(`PowerPoint : ${error.message}`);
      }
    }
    if (!slides) {
      const soffice = findLibreOffice();
      if (soffice) {
        try {
          slides = await convertWithLibreOffice(
            soffice,
            item.path,
            outDir,
            path.join(cacheRoot, "libreoffice")
          );
        } catch (error) {
          errors.push(`LibreOffice : ${error.message}`);
        }
      }
    }
    if (!slides) {
      const error = new Error(
        "Impossible de convertir cette présentation. Installez PowerPoint ou LibreOffice (gratuit), ou enregistrez-la en PDF."
      );
      error.details = errors;
      throw error;
    }
    fs.writeFileSync(doneFile, JSON.stringify(slides));
    return slides;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

module.exports = { describe, prepare, typeOf, DIALOG_FILTERS };
