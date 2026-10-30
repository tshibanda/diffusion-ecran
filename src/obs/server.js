// Serveur local du flux OBS (uniquement sur cet ordinateur, 127.0.0.1) :
//   /           page pour une « Source navigateur » d'OBS (image + son)
//   /direct     flux de cette page : images et son encodés, envoyés un par un
//   /live.mp4   flux image + son (H.264/Opus) pour une « Source média »
//   /live.webm  même flux en WebM (VP8/Opus), si H.264 pose problème
//   /flux.mjpg  flux image seule (MJPEG), le plus léger
//   /image.jpg  dernière image
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const FIRST_PORT = 8765;
const LAST_PORT = 8775;
const BOUNDARY = "diffusionecran";
// Identifiant de ce lancement de l'application : la page d'OBS le compare
// régulièrement et se recharge d'elle-même après un redémarrage ou une mise à
// jour (plus besoin de « Rafraîchir le cache de la page » dans OBS).
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const VIEWER = fs
  .readFileSync(path.join(__dirname, "viewer.html"), "utf8")
  .replace("__BOOT_ID__", BOOT_ID);
// Lecture du son dans la page (réserve régulière, voir pcm-worklet.js).
const PCM_WORKLET = fs.readFileSync(path.join(__dirname, "pcm-worklet.js"));
const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

// Flux /direct : une suite de messages [type (1 octet), image clé (1 octet),
// horodatage en µs (8 octets), longueur (4 octets), contenu].
const DIRECT_TYPES = { "video-config": 1, video: 2, "audio-config": 3, audio: 4 };
// Client en retard de plus de ce volume en attente : il saute jusqu'à la
// prochaine image clé (mieux qu'un retard qui s'accumule).
const DIRECT_MAX_PENDING = 8 * 1024 * 1024;

function directMessage(kind, key, timestamp, payload) {
  const header = Buffer.alloc(14);
  header.writeUInt8(DIRECT_TYPES[kind], 0);
  header.writeUInt8(key ? 1 : 0, 1);
  header.writeDoubleLE(timestamp || 0, 2);
  header.writeUInt32LE(payload.length, 10);
  return Buffer.concat([header, payload]);
}

function createObsServer({ onClientsChanged, onWebmClient, onDirectClient }) {
  const clients = new Set(); // flux MJPEG
  const webmClients = new Map(); // id -> réponse HTTP
  const directClients = new Set(); // { res, waitingKey }
  const directConfig = {}; // dernières configurations vidéo et son
  let nextWebmId = 1;
  let lastFrame = null;
  let port = null;

  const counts = () => ({ mjpeg: clients.size, webm: webmClients.size, direct: directClients.size });
  const notify = () => onClientsChanged(counts());

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
      return res.end(VIEWER);
    }
    if (url.pathname === "/pcm-worklet.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", ...NO_CACHE });
      return res.end(PCM_WORKLET);
    }
    if (url.pathname === "/version") {
      res.writeHead(200, { "Content-Type": "application/json", ...NO_CACHE });
      return res.end(JSON.stringify({ boot: BOOT_ID }));
    }
    if (url.pathname === "/image.jpg") {
      if (!lastFrame) {
        res.writeHead(503);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
      return res.end(lastFrame);
    }
    if (url.pathname === "/direct") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", ...NO_CACHE, Connection: "close" });
      const client = { res, waitingKey: true };
      for (const kind of ["video-config", "audio-config"]) {
        if (directConfig[kind]) res.write(directConfig[kind]);
      }
      directClients.add(client);
      req.on("close", () => {
        directClients.delete(client);
        notify();
      });
      notify();
      onDirectClient();
      return;
    }
    if (url.pathname === "/live.mp4" || url.pathname === "/live.webm") {
      const format = url.pathname === "/live.mp4" ? "mp4" : "webm";
      res.writeHead(200, {
        "Content-Type": format === "mp4" ? "video/mp4" : "video/webm",
        ...NO_CACHE,
        Connection: "close",
      });
      const id = nextWebmId++;
      webmClients.set(id, res);
      req.on("close", () => {
        webmClients.delete(id);
        onWebmClient(id, false);
        notify();
      });
      notify();
      onWebmClient(id, true, format);
      return;
    }
    if (url.pathname === "/flux.mjpg") {
      res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        ...NO_CACHE,
        Connection: "close",
      });
      const client = { res, busy: false };
      clients.add(client);
      res.on("drain", () => (client.busy = false));
      req.on("close", () => {
        clients.delete(client);
        notify();
      });
      notify();
      if (lastFrame) writeFrame(client, lastFrame);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  function writeFrame(client, frame) {
    // Client en retard (OBS occupé) : on saute des images plutôt que d'accumuler.
    if (client.busy) return;
    client.res.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    client.res.write(frame);
    client.busy = !client.res.write("\r\n");
  }

  function pushFrame(frame) {
    lastFrame = frame;
    for (const client of clients) writeFrame(client, frame);
  }

  function pushChunk(id, chunk) {
    const res = webmClients.get(id);
    if (res) res.write(chunk);
  }

  // Message du flux direct (voir obs/relay.js : sendDirect).
  function pushDirect({ kind, key, timestamp, data, config }) {
    if (kind === "video-config" || kind === "audio-config") {
      const message = directMessage(kind, false, 0, Buffer.from(JSON.stringify(config)));
      directConfig[kind] = message;
      for (const client of directClients) {
        client.res.write(message);
        if (kind === "video-config") client.waitingKey = true;
      }
      return;
    }
    const message = directMessage(kind, key, timestamp, Buffer.from(data));
    for (const client of directClients) {
      // On commence (et on reprend après un retard) par une image clé ; le son
      // ne part qu'une fois l'image lancée.
      if (client.waitingKey) {
        if (kind !== "video" || !key) continue;
        client.waitingKey = false;
      }
      if (client.res.writableLength > DIRECT_MAX_PENDING) {
        client.waitingKey = true;
        onDirectClient();
        continue;
      }
      client.res.write(message);
    }
  }

  function listen(candidate = FIRST_PORT) {
    return new Promise((resolve) => {
      server.once("error", () => {
        if (candidate >= LAST_PORT) return resolve(null);
        resolve(listen(candidate + 1));
      });
      server.listen(candidate, HOST, () => {
        port = candidate;
        resolve(port);
      });
    });
  }

  return {
    listen,
    pushFrame,
    pushChunk,
    pushDirect,
    urls: () =>
      port
        ? {
            page: `http://${HOST}:${port}/`,
            stream: `http://${HOST}:${port}/live.mp4`,
            mjpeg: `http://${HOST}:${port}/flux.mjpg`,
          }
        : null,
    counts,
    // Coupe les flux WebM : les clients se reconnectent (nouvelle qualité).
    dropWebmClients: () => {
      for (const res of webmClients.values()) res.end();
    },
    clientCount: () => clients.size + webmClients.size + directClients.size,
    close: () => {
      for (const { res } of clients) res.end();
      for (const res of webmClients.values()) res.end();
      for (const { res } of directClients) res.end();
      server.close();
    },
  };
}

module.exports = { createObsServer };
