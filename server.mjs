import { createServer } from "node:http";
import { readFile, readdir, unlink } from "node:fs/promises";
import { fork } from "node:child_process";
import path from "node:path";
import { ROOT, DATA, PORT, HOST, ORIGIN } from "./lib/config.mjs";
import { db } from "./lib/db.mjs";
import { api, json, fail } from "./lib/api.mjs";
import { acquireServerLock } from "./lib/server-lock.mjs";
acquireServerLock();
const files = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/mvp.css": "mvp.css",
  "/studio.js": "studio.js",
  "/account.js": "account.js",
  "/launch.js": "launch.js",
  "/launch.css": "launch.css",
  "/discovery.js": "discovery.js",
  "/growth.css": "growth.css",
  "/templates.js": "templates.js",
  "/template-core.js": "template-core.js",
  "/templates.css": "templates.css",
  "/sobre": "landing.html",
  "/landing.html": "landing.html",
  "/favicon.ico": null,
};
let worker,
  workerReady = false,
  closing = false,
  restartTimer;
let automation, automationTimer;
function startAutomation() {
  automation = fork(path.join(ROOT, "automation-worker.mjs"), {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  automation.on("exit", () => {
    if (!closing) automationTimer = setTimeout(startAutomation, 1500);
  });
}
function startWorker() {
  worker = fork(path.join(ROOT, "worker.mjs"), {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  worker.on("message", (m) => {
    if (m === "ready") workerReady = true;
  });
  worker.on("exit", () => {
    workerReady = false;
    if (!closing) restartTimer = setTimeout(startWorker, 1500);
  });
}
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    if (
      req.headers.host !== new URL(ORIGIN).host &&
      req.headers.host !== process.env.BACKEND_HOST
    )
      fail("Host não autorizado.", 403);
    const url = new URL(req.url, ORIGIN);
    if (url.pathname.startsWith("/api/"))
      return await api(req, res, url, workerReady);
    if (!["GET", "HEAD"].includes(req.method))
      fail("Método não permitido.", 405);
    if (!Object.hasOwn(files, url.pathname)) fail("Não encontrado.", 404);
    const file = files[url.pathname];
    if (!file) {
      res.writeHead(204);
      res.end();
      return;
    }
    const data = await readFile(path.join(ROOT, "dist", file));
    res.writeHead(200, {
      "Content-Type": file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : "text/html; charset=utf-8",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (!e.status) console.error("Request error", e.message);
    json(res, e.status || 500, {
      error: e.status
        ? e.message
        : "Ocorreu um erro no servidor. Tente novamente.",
    });
  }
});
server.requestTimeout = 5 * 60000;
server.headersTimeout = 30000;
server.listen(PORT, HOST, async () => {
  for (const name of await readdir(path.join(DATA, "temp")))
    if (/^[a-f0-9-]{36}\.(upload|png)$/.test(name))
      await unlink(path.join(DATA, "temp", name)).catch(() => {});
  startWorker();
  startAutomation();
  console.log(`ViceClipz MVP: ${ORIGIN}`);
});
server.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
function stop() {
  if (closing) return;
  closing = true;
  clearTimeout(restartTimer);
  clearTimeout(automationTimer);
  if (automation?.connected) automation.send("stop");
  if (worker?.connected) worker.send("stop");
  server.close(() => db.close());
  setTimeout(() => {
    worker?.kill();
    automation?.kill();
    process.exit(0);
  }, 2500).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("message", (m) => {
  if (m === "stop") stop();
});
