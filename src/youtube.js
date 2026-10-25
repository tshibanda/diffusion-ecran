// Outils YouTube côté processus principal : lecture des liens collés par
// l'utilisateur et script injecté dans la page YouTube de projection.
const fs = require("fs");
const path = require("path");

const VIDEO_ID = /^[\w-]{11}$/;

// "90", "90s", "1m30s", "1h2m3s" -> secondes.
function parseTime(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = String(value).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function parseYoutubeUrl(input) {
  let text = String(input || "").trim();
  if (!text) return null;

  let id = null;
  let start = 0;
  let list = null;
  if (VIDEO_ID.test(text)) {
    id = text;
  } else {
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") {
      id = url.pathname.slice(1).split("/")[0];
    } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") {
        id = url.searchParams.get("v");
      } else {
        const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
        if (m) id = m[2];
      }
    } else {
      return null;
    }
    start = parseTime(url.searchParams.get("t") || url.searchParams.get("start"));
    list = url.searchParams.get("list");
  }
  if (!id || !VIDEO_ID.test(id)) return null;

  let watchUrl = `https://www.youtube.com/watch?v=${id}`;
  if (list) watchUrl += `&list=${encodeURIComponent(list)}`;
  if (start) watchUrl += `&t=${start}s`;
  return {
    videoId: id,
    watchUrl,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

// Script exécuté dans la page YouTube (voir youtube-page.js). Il est
// réinjecté à chaque « tick » : il ne s'installe qu'une seule fois.
const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, "youtube-page.js"), "utf8");

module.exports = { parseYoutubeUrl, PAGE_SCRIPT };
