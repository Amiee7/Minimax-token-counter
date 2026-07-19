// src/server.mjs
//
// Tiny HTTP server. Exposes:
//   GET  /api/config                    — priceBook + settings + db path info
//   GET  /api/minimax                   — full dashboard payload (MiniMax app)
//   GET  /api/minimax/live              — small live snapshot (for polling)
//   GET  /api/opencode                  — full dashboard payload (OpenCode, MiniMax models only in UI)
//   GET  /api/opencode/live             — small live snapshot (OpenCode)
//   POST /api/settings/paths            — save settings
//   POST /api/settings/prices           — save price book
//
// Everything else falls through to public/ as static files.

import http from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKSPACE_ROOT,
  PRICE_BOOK_PATH,
  loadPriceBook,
  savePriceBook
} from "./pricing.mjs";
import {
  SETTINGS_PATH,
  loadSettings,
  saveSettings
} from "./settings.mjs";
import {
  loadData as loadMiniMaxData,
  loadLive as loadMiniMaxLive,
  MINIMAX_DB_PATH
} from "./sources/minimax.mjs";
import {
  loadData as loadOpenCodeData,
  loadLive as loadOpenCodeLive,
  OPENCODE_DB_PATH
} from "./sources/opencode.mjs";
import { createTimedCache } from "./timedCache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(WORKSPACE_ROOT, "public");
const HOST = process.env.HOST || "127.0.0.1";
const START_PORT = Number.parseInt(process.env.PORT || "4967", 10);
const summaryCache = createTimedCache({ ttlMs: 8000 });
const liveCache = createTimedCache({ ttlMs: 1500 });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${START_PORT}`}`);

    if (url.pathname === "/api/config" && req.method === "GET") {
      return json(res, await configPayload());
    }
    if (url.pathname === "/api/minimax" && req.method === "GET") {
      const priceBook = await loadPriceBook();
      return json(res, await loadCached(summaryCache, url, async () => loadMiniMaxData(url.searchParams, priceBook, await loadSettings())));
    }
    if (url.pathname === "/api/minimax/live" && req.method === "GET") {
      const priceBook = await loadPriceBook();
      return json(res, await loadCached(liveCache, url, async () => loadMiniMaxLive(url.searchParams, priceBook, await loadSettings())));
    }
    if (url.pathname === "/api/opencode" && req.method === "GET") {
      const priceBook = await loadPriceBook();
      return json(res, await loadCached(summaryCache, url, async () => loadOpenCodeData(url.searchParams, priceBook, await loadSettings())));
    }
    if (url.pathname === "/api/opencode/live" && req.method === "GET") {
      const priceBook = await loadPriceBook();
      return json(res, await loadCached(liveCache, url, async () => loadOpenCodeLive(url.searchParams, priceBook, await loadSettings())));
    }
    if (url.pathname === "/api/settings/paths" && req.method === "POST") {
      const body = await readJson(req);
      summaryCache.clear();
      liveCache.clear();
      return json(res, { settings: await saveSettings(body.settings || {}) });
    }
    if (url.pathname === "/api/settings/prices" && req.method === "POST") {
      const body = await readJson(req);
      summaryCache.clear();
      liveCache.clear();
      return json(res, { priceBook: await savePriceBook(body.priceBook) });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    json(res, { error: error.message, code: error.code || null }, error.statusCode || 500);
  }
});

listenWithFallback(server, START_PORT);

async function loadCached(cache, url, loader) {
  const params = new URLSearchParams(url.searchParams);
  const force = params.get("force") === "1";
  params.delete("force");
  return cache.get(`${url.pathname}?${params.toString()}`, loader, { force });
}

async function configPayload() {
  const priceBook = await loadPriceBook();
  const settings = await loadSettings();
  return {
    app: { name: "MiniMax Token Counter", workspaceRoot: WORKSPACE_ROOT },
    sources: {
      minimax: {
        label: "MiniMax App",
        dataSource: settings.minimaxDbPath || MINIMAX_DB_PATH
      },
      opencode: {
        label: "OpenCode Zen",
        dataSource: settings.opencodeDbPath || OPENCODE_DB_PATH
      },
      "opencode-go": {
        label: "OpenCode Go",
        dataSource: settings.opencodeDbPath || OPENCODE_DB_PATH
      }
    },
    priceBookPath: PRICE_BOOK_PATH,
    settingsPath: SETTINGS_PATH,
    settings,
    priceBook
  };
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return text(res, "Not found", 404, "text/plain; charset=utf-8");
  }
  try {
    const data = await readFile(filePath);
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    const fallback = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" });
    res.end(fallback);
  }
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function text(res, body, status, type) {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function listenWithFallback(instance, port, attempts = 12) {
  let current = port;
  let remaining = attempts;
  instance.on("error", (error) => {
    if (error.code === "EADDRINUSE" && remaining > 0) {
      remaining -= 1;
      current += 1;
      instance.listen(current, HOST);
      return;
    }
    throw error;
  });
  instance.listen(current, HOST, () => {
    const address = instance.address();
    const url = `http://${HOST}:${address.port}`;
    console.log(`MiniMax Token Counter: ${url}`);
    if (process.env.OPEN_BROWSER) maybeOpenBrowser(url);
  });
}

function maybeOpenBrowser(url) {
  if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, () => {});
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [url], { windowsHide: true }, () => {});
}
