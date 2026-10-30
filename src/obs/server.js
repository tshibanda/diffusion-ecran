// Serveur local du flux OBS (uniquement sur cet ordinateur, 127.0.0.1) :
//   /           page pour une « Source navigateur » d'OBS (image + son)
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
const VIEWER = fs.readFileSync(path.join(__dirname, "viewer.html"));

function createObsServer({ onClientsChanged, onWebmClient }) {
  const clients = new Set(); // flux MJPEG
  const webmClients = new Map(); // id -> réponse HTTP
  let nextWebmId = 1;
  let lastFrame = null;
  let port = null;

  const counts = () => ({ mjpeg: clients.size, webm: webmClients.size });
  const notify = () => onClientsChanged(counts());

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(VIEWER);
    }
    if (url.pathname === "/image.jpg") {
      if (!lastFrame) {
        res.writeHead(503);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
      return res.end(lastFrame);
    }
    if (url.pathname === "/live.mp4" || url.pathname === "/live.webm") {
      const format = url.pathname === "/live.mp4" ? "mp4" : "webm";
      res.writeHead(200, {
        "Content-Type": format === "mp4" ? "video/mp4" : "video/webm",
        "Cache-Control": "no-store",
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
        "Cache-Control": "no-store",
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
    clientCount: () => clients.size + webmClients.size,
    close: () => {
      for (const { res } of clients) res.end();
      for (const res of webmClients.values()) res.end();
      server.close();
    },
  };
}

module.exports = { createObsServer };
