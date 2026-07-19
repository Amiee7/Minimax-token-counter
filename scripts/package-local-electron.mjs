import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "..");
const outputRoot = process.env.MINIMAX_TC_OUTPUT_ROOT
  ? path.resolve(process.env.MINIMAX_TC_OUTPUT_ROOT)
  : path.join(sourceRoot, "dist");
const electronDistCandidates = [
  process.env.ELECTRON_DIST,
  process.env.ELECTRON_PATH ? path.dirname(process.env.ELECTRON_PATH) : null,
  path.join(sourceRoot, "node_modules", "electron", "dist")
].filter(Boolean);
const electronDist = electronDistCandidates.find((candidate) => existsSync(path.join(candidate, "electron.exe")));

if (!electronDist) {
  throw new Error(`Electron runtime not found. Checked:\n  ${electronDistCandidates.join("\n  ")}\nRun npm install first.`);
}

const outDir = path.join(outputRoot, "MiniMaxTokenCounter");
const appDir = path.join(outDir, "resources", "app");
if (!process.env.MINIMAX_TC_OUTPUT_ROOT && !outDir.startsWith(sourceRoot)) {
  throw new Error(`Refusing to write outside repository: ${outDir}`);
}

console.log("Cleaning previous build...");
await rm(outDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

console.log("Building single-file launcher...");
const cscCandidates = [
  process.env.CSC_PATH,
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"
].filter(Boolean);
const csc = cscCandidates.find(existsSync);
if (!csc) throw new Error(`C# compiler not found. Checked:\n  ${cscCandidates.join("\n  ")}`);
const launcherSource = path.join(__dirname, "MiniMaxTokenCounterLauncher.cs");
await mkdir(outputRoot, { recursive: true });
const launcherOutput = path.join(outputRoot, "MiniMaxTokenCounter.exe");
await run(csc, [
  "/nologo",
  "/target:winexe",
  `/win32icon:${path.join(sourceRoot, "assets", "icon.ico")}`,
  `/out:${launcherOutput}`,
  launcherSource
]);
if (!existsSync(launcherOutput)) throw new Error(`Launcher build output not found at ${launcherOutput}`);

for (const stale of [
  "MiniMaxTokenCounterLauncher.exe",
  "MiniMaxTokenCounterLauncher.dll",
  "MiniMaxTokenCounterLauncher.deps.json",
  "MiniMaxTokenCounterLauncher.runtimeconfig.json"
]) {
  await rm(path.join(outputRoot, stale), { force: true });
}

console.log("Copying Electron runtime...");
await cp(electronDist, outDir, { recursive: true });
await rm(path.join(outDir, "electron.exe"), { force: true });
await cp(path.join(electronDist, "electron.exe"), path.join(outDir, "MiniMaxTokenCounter.exe"));

console.log("Copying application sources...");
for (const item of ["package.json", "electron", "src", "public", "data", "assets"]) {
  const from = path.join(sourceRoot, item);
  if (existsSync(from)) await cp(from, path.join(appDir, item), { recursive: true });
}
for (const stale of ["electron-user-data", "electron-session-data"]) {
  await rm(path.join(appDir, "data", stale), { recursive: true, force: true });
}

const packagePath = path.join(appDir, "package.json");
const pkg = JSON.parse(await readFile(packagePath, "utf8"));
pkg.main = "electron/main.cjs";
delete pkg.devDependencies;
delete pkg.build;
await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

const localesDir = path.join(outDir, "locales");
if (existsSync(localesDir)) {
  for (const fileName of await readdir(localesDir)) {
    if (!["de.pak", "en-US.pak", "en-GB.pak"].includes(fileName)) {
      await rm(path.join(localesDir, fileName), { force: true });
    }
  }
}

console.log(`\nBuilt launcher: ${launcherOutput}`);
console.log(`Portable application: ${outDir}`);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: sourceRoot, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited with code ${code}`)));
  });
}
