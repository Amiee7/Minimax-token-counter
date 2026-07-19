// scripts/run-electron.mjs
//
// Convenience launcher for `npm run desktop` during development.
// Finds a local Electron binary and spawns it. No Electron? Run `npm install`
// first — the binary lands in node_modules/electron/dist/.

import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const candidates = [
  process.env.ELECTRON_PATH,
  path.join(root, "node_modules", "electron", "dist", "electron.exe"),
  path.join(root, "node_modules", ".bin", "electron"),
  "/usr/bin/electron",
  "/usr/local/bin/electron"
].filter(Boolean);

const electronPath = candidates.find((candidate) => existsSync(candidate));

if (!electronPath) {
  console.error("Electron not found. Run `npm install` first, or set ELECTRON_PATH to an Electron binary.");
  process.exit(1);
}

const debug = !!process.env.MINIMAX_TC_DEBUG;
const childEnv = { ...process.env, MINIMAX_TC_DESKTOP: "1" };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [root], {
  cwd: root,
  stdio: debug ? "inherit" : "ignore",
  windowsHide: !debug,
  env: childEnv
});

if (!debug) {
  child.unref();
  process.exit(0);
}

child.on("exit", (code) => process.exit(code ?? 0));
