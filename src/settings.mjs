import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_ROOT } from "./pricing.mjs";

export const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");

const DEFAULT_SETTINGS = {
  minimaxDbPath: path.join(os.homedir(), ".minimax", "sqlite.db"),
  opencodeDbPath: path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
};

export async function loadSettings() {
  try {
    const text = await readFile(SETTINGS_PATH, "utf8");
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(text) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function normalizeSettings(settings) {
  return {
    minimaxDbPath: String(settings.minimaxDbPath || DEFAULT_SETTINGS.minimaxDbPath).trim(),
    opencodeDbPath: String(settings.opencodeDbPath || DEFAULT_SETTINGS.opencodeDbPath).trim()
  };
}
