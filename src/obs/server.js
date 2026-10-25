// Serveur local du flux OBS (uniquement sur cet ordinateur, 127.0.0.1) :
//   /           page pour une « Source navigateur » d'OBS
//   /flux.mjpg  flux vidéo MJPEG pour une « Source média » d'OBS
//   /image.jpg  dernière image
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const FIRST_PORT = 8765;
const LAST_PORT = 8775;
const BOUNDARY = "diffusionecran";
const VIEWER = fs.readFileSync(path.join(__dirname, "viewer.html"));

function createObsServer({ onClientsChanged }) {
  const clients = new Set();
  let lastFrame = null;
  let port = null;

  const notify = () => onClientsChanged(clients.size);

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
    urls: () =>
      port
        ? { page: `http://${HOST}:${port}/`, stream: `http://${HOST}:${port}/flux.mjpg` }
        : null,
    clientCount: () => clients.size,
    close: () => {
      for (const { res } of clients) res.end();
      server.close();
    },
  };
}

module.exports = { createObsServer };
