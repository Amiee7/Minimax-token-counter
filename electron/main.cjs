// electron/main.cjs
//
// Electron main process for the MiniMax Token Counter desktop app.
//
// 1. Boots the local Node HTTP server (src/server.mjs) as a child process.
// 2. Waits for the server to print "http://127.0.0.1:<port>" and then opens
//    a BrowserWindow pointing at it.
// 3. On quit / window-close it kills the child cleanly.
//
// User-data (settings.json, prices.json, window state, logs) lives under
// %APPDATA%\MiniMaxTokenCounter\. The shipped data/ files are copied on
// first launch as defaults.

const { app, BrowserWindow, Menu, screen, shell, utilityProcess } = require("electron");
const { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const root = path.resolve(__dirname, "..");
const host = "127.0.0.1";
const preferredPort = Number(process.env.PORT || 4967);

const appDataRoot = process.env.MINIMAX_TC_APPDATA_DIR || path.join(app.getPath("appData"), "MiniMaxTokenCounter");
const dataPath = path.join(appDataRoot, "data");
const userDataPath = path.join(appDataRoot, "electron-user-data");
const sessionDataPath = path.join(appDataRoot, "electron-session-data");
const logPath = path.join(dataPath, "electron-start.log");
const windowStatePath = path.join(dataPath, "window-state.json");
const iconPath = path.join(root, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

let mainWindow = null;
let serverProcess = null;
let serverUrl = null;
let isQuitting = false;
let serverRestartTimer = null;
let windowStateTimer = null;

// --- bootstrap ---------------------------------------------------------------

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.setAppUserModelId("MiniMax.TokenCounter");
mkdirSync(dataPath, { recursive: true });
mkdirSync(userDataPath, { recursive: true });
mkdirSync(sessionDataPath, { recursive: true });
seedDataFile("settings.json");
syncPriceBook();
app.setPath("userData", userDataPath);
app.setPath("sessionData", sessionDataPath);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  log("app ready");
  Menu.setApplicationMenu(null);
  try {
    serverUrl = await startInternalServer();
    log(`server ${serverUrl}`);
  } catch (error) {
    log(`startup error: ${error.stack || error.message}`);
    console.error(error);
    app.quit();
    return;
  }
  if (process.argv.includes("--ui-smoke-test")) {
    await runUiSmokeTest(serverUrl);
    app.quit();
    return;
  }
  if (process.argv.includes("--smoke-test")) {
    await runSmokeTest(serverUrl);
    app.quit();
    return;
  }
  createWindow(serverUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(serverUrl);
  });
}).catch((error) => {
  log(`startup error: ${error.stack || error.message}`);
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  stopInternalServer();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => { isQuitting = true; stopInternalServer(); });
app.on("will-quit", stopInternalServer);
app.on("quit", stopInternalServer);
process.on("exit", stopInternalServer);

// --- window ------------------------------------------------------------------

function createWindow(url) {
  log(`create window ${url}`);
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 680,
    minHeight: 560,
    backgroundColor: "#fafafb",
    title: "MiniMax Token Counter",
    icon: existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      backgroundThrottling: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  const reveal = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  };

  mainWindow.once("ready-to-show", reveal);
  mainWindow.webContents.on("dom-ready", reveal);
  mainWindow.webContents.on("did-finish-load", reveal);
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    log(`did-fail-load ${code}: ${description}`);
    reveal();
  });

  mainWindow.on("resize", scheduleWindowStateSave);
  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("maximize", saveWindowState);
  mainWindow.on("unmaximize", saveWindowState);
  mainWindow.on("close", saveWindowState);
  mainWindow.on("closed", () => { mainWindow = null; });

  mainWindow.loadURL(url).catch((error) => {
    log(`loadURL error: ${error.stack || error.message}`);
  });
  setTimeout(reveal, 500);
  setTimeout(reveal, 2000);
}

function loadWindowState() {
  const fallback = { bounds: { width: 1280, height: 820 }, maximized: false };
  if (!existsSync(windowStatePath)) return fallback;
  try {
    const state = JSON.parse(readFileSync(windowStatePath, "utf8"));
    const b = state && typeof state === "object" ? state.bounds : null;
    const width = Number(b?.width);
    const height = Number(b?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback;
    const workArea = screen.getPrimaryDisplay().workArea;
    const x = Number.isFinite(Number(b.x)) ? Number(b.x) : undefined;
    const y = Number.isFinite(Number(b.y)) ? Number(b.y) : undefined;
    const savedBounds = { x, y, width, height };
    const visible = x === undefined || y === undefined || screen.getAllDisplays().some(({ workArea: area }) => (
      x < area.x + area.width - 80 &&
      y < area.y + area.height - 80 &&
      x + width > area.x + 80 &&
      y + height > area.y + 80
    ));
    return {
      bounds: {
        x: visible ? savedBounds.x : undefined,
        y: visible ? savedBounds.y : undefined,
        width: clamp(Math.round(width), 680, Math.max(workArea.width, 680)),
        height: clamp(Math.round(height), 560, Math.max(workArea.height, 560))
      },
      maximized: Boolean(state.maximized)
    };
  } catch (error) {
    log(`window state read error: ${error.message}`);
    return fallback;
  }
}

function scheduleWindowStateSave() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    saveWindowState();
  }, 200);
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    const bounds = maximized || mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    writeFileSync(windowStatePath, `${JSON.stringify({ bounds, maximized }, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`window state write error: ${error.message}`);
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// --- server lifecycle --------------------------------------------------------

function startInternalServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOST: host,
      PORT: String(preferredPort),
      OPEN_BROWSER: "",
      MINIMAX_TC_DATA_DIR: dataPath
    };

    serverProcess = utilityProcess.fork(path.join(root, "src", "server.mjs"), [], {
      cwd: root,
      env,
      serviceName: "MiniMax Token Counter Data Server",
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let stderr = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopInternalServer();
      reject(new Error(`Server did not start within 20s. ${stderr}`));
    }, 20_000);

    serverProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      logServerLines("server stdout", text);
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });

    serverProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logServerLines("server stderr", text);
    });

    serverProcess.on("error", (type, location, report) => {
      const error = new Error(`${type || "Utility process error"}${location ? ` at ${location}` : ""}${report ? `: ${report}` : ""}`);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    serverProcess.on("exit", (code, signal) => {
      serverProcess = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before listening. ${stderr}`));
      } else if (!isQuitting) {
        log(`server exited unexpectedly code=${code ?? "-"} signal=${signal ?? "-"}`);
        scheduleServerRestart();
      }
    });
  });
}

function scheduleServerRestart() {
  if (serverRestartTimer || isQuitting) return;
  serverRestartTimer = setTimeout(async () => {
    serverRestartTimer = null;
    if (isQuitting) return;
    try {
      serverUrl = await startInternalServer();
      log(`server restarted ${serverUrl}`);
      if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(serverUrl);
    } catch (error) {
      log(`server restart failed: ${error.stack || error.message}`);
      scheduleServerRestart();
    }
  }, 800);
}

function stopInternalServer() {
  if (serverRestartTimer) {
    clearTimeout(serverRestartTimer);
    serverRestartTimer = null;
  }
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  if (child.killed) return;
  try {
    child.kill();
  } catch {
    // best effort only
  }
}

// --- helpers -----------------------------------------------------------------

function log(message) {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch { /* best effort */ }
}

function logServerLines(prefix, text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.trim()) log(`${prefix}: ${line}`);
  }
}

function runSmokeTest(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/minimax?days=30&limit=5`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Smoke test returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (payload.source !== "minimax" || !payload.events) throw new Error("Invalid MiniMax payload");
          log(`smoke test passed events=${payload.events.total?.events || 0}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("Smoke test timed out")));
    request.on("error", reject);
  });
}

async function runUiSmokeTest(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#fafafb",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    window.webContents.on("console-message", (_event, level, message) => log(`ui console level=${level}: ${message}`));
    window.webContents.on("render-process-gone", (_event, details) => log(`ui renderer gone: ${JSON.stringify(details)}`));
    await window.loadURL(url);
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const inspect = () => {
          const metrics = document.querySelectorAll(".metric").length;
          if (metrics >= 4 || Date.now() - started > 20_000) resolve();
          else setTimeout(inspect, 100);
        };
        inspect();
      })`);
    for (const width of [1280, 700]) {
      window.setSize(width, 800);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const state = await window.webContents.executeJavaScript(`({
        title: document.title,
        loading: document.body.innerText.includes("Loading MiniMax App data"),
        metrics: document.querySelectorAll(".metric").length,
        source: document.querySelector("#sourceSelect")?.value,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        body: document.body.innerText.slice(0, 500)
      })`);
      if (state.title !== "MiniMax Token Counter" || state.loading || state.metrics < 4 || state.horizontalOverflow) {
        throw new Error(`UI smoke test failed at ${width}px: ${JSON.stringify(state)}`);
      }
      const image = await window.webContents.capturePage();
      writeFileSync(path.join(dataPath, `ui-smoke-${width}.png`), image.toPNG());
      log(`ui smoke passed width=${width} source=${state.source} metrics=${state.metrics}`);
    }
  } finally {
    window.destroy();
  }
}

function seedDataFile(fileName) {
  const target = path.join(dataPath, fileName);
  if (existsSync(target)) return;
  const source = path.join(root, "data", fileName);
  if (!existsSync(source)) return;
  try {
    copyFileSync(source, target);
  } catch { /* best effort */ }
}

function syncPriceBook() {
  const source = path.join(root, "data", "prices.json");
  const target = path.join(dataPath, "prices.json");
  if (!existsSync(source)) return;
  if (!existsSync(target)) {
    seedDataFile("prices.json");
    return;
  }
  try {
    const sourceVersion = Number(JSON.parse(readFileSync(source, "utf8")).priceBookVersion) || 1;
    const targetVersion = Number(JSON.parse(readFileSync(target, "utf8")).priceBookVersion) || 1;
    if (targetVersion < sourceVersion) copyFileSync(source, target);
  } catch {
    // A damaged local price book is replaced by the shipped, validated default.
    copyFileSync(source, target);
  }
}
