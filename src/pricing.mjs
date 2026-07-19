import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(__dirname, "..");
export const DATA_ROOT = process.env.MINIMAX_TC_DATA_DIR || path.join(WORKSPACE_ROOT, "data");
export const PRICE_BOOK_PATH = path.join(DATA_ROOT, "prices.json");

export async function loadPriceBook() {
  const text = await readFile(PRICE_BOOK_PATH, "utf8");
  return normalizePriceBook(JSON.parse(text));
}

export async function savePriceBook(nextBook) {
  const normalized = normalizePriceBook(nextBook);
  await mkdir(path.dirname(PRICE_BOOK_PATH), { recursive: true });
  await writeFile(PRICE_BOOK_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function normalizePriceBook(book) {
  if (!book || typeof book !== "object") throw new Error("Invalid price book.");
  const presets = book.presets || {};
  for (const [name, value] of Object.entries(presets)) {
    for (const field of ["input", "cached", "output"]) {
      const number = Number(value?.[field]);
      if (!Number.isFinite(number) || number < 0) {
        throw new Error(`Invalid price for ${name}.${field}.`);
      }
      value[field] = number;
    }
    if (value.cacheWrite !== undefined) {
      const number = Number(value.cacheWrite);
      if (!Number.isFinite(number) || number < 0) {
        throw new Error(`Invalid price for ${name}.cacheWrite.`);
      }
      value.cacheWrite = number;
    }
  }
  return {
    priceBookVersion: Number(book.priceBookVersion) || 1,
    updatedAt: typeof book.updatedAt === "string" ? book.updatedAt : null,
    defaultPreset: book.defaultPreset || "minimax-m3",
    comparePresets: Array.isArray(book.comparePresets) ? book.comparePresets : Object.keys(presets),
    aliases: book.aliases || {},
    notes: book.notes || {},
    presets
  };
}

export function normalPricePreset(name, priceBook) {
  if (!name) return null;
  return priceBook.aliases?.[name] || name;
}

export function priceForPreset(name, priceBook) {
  const normalized = normalPricePreset(name, priceBook);
  return normalized ? priceBook.presets?.[normalized] || null : null;
}

/**
 * Rewrite a model id to its OpenCode-billing-specific preset, mirroring
 * the original Token-Counter-Tool behavior. With billing=go the preset is
 * prefixed "opencode-go/", with billing=zen it is prefixed "opencode-zen/",
 * so the price book can carry separate rates. With billing=api (default)
 * the preset is used as-is.
 */
export function billingPricePreset(modelId, billing, priceBook) {
  const apiPreset = normalPricePreset(modelId, priceBook);
  if (billing === "zen") {
    if (apiPreset) {
      const zenPreset = `opencode-zen/${apiPreset}`;
      if (priceBook.presets?.[zenPreset]) return zenPreset;
    }
    const directPreset = `opencode-zen/${modelId}`;
    return priceBook.presets?.[directPreset] ? directPreset : null;
  }
  if (!apiPreset) {
    const directPreset = `opencode-go/${modelId}`;
    return billing === "go" && priceBook.presets?.[directPreset] ? directPreset : null;
  }
  if (billing !== "go" || String(apiPreset).startsWith("opencode-go/")) return apiPreset;
  const goPreset = `opencode-go/${apiPreset}`;
  return priceBook.presets?.[goPreset] ? goPreset : apiPreset;
}

/**
 * Estimate USD cost for one usage row against a given preset.
 *
 * MiniMax Code (via OpenCode-style providers) bills:
 *   - input tokens at the input price
 *   - cache read at the cached price
 *   - cache write at the cacheWrite price (or input price as fallback)
 *   - output + reasoning at the output price
 */
export function estimateMiniMaxCost(usage, preset, priceBook) {
  const prices = priceForPreset(preset, priceBook);
  if (!usage || !prices) return null;
  const cacheWritePrice = prices.cacheWrite ?? prices.input;
  const billableOutput = number(usage.output) + number(usage.reasoning);
  return (
    number(usage.input) / 1_000_000 * prices.input +
    number(usage.cacheWrite) / 1_000_000 * cacheWritePrice +
    number(usage.cacheRead) / 1_000_000 * prices.cached +
    billableOutput / 1_000_000 * prices.output
  );
}

export function compareNoteCode(preset, priceBook) {
  const normalized = normalPricePreset(preset, priceBook);
  if (preset !== normalized) return `as ${normalized}`;
  const note = priceBook.notes?.[normalized] || "";
  if (note.includes("cached=input")) return "C=IN";
  if (note.includes("OpenRouter")) return "OR";
  return "";
}

export function compareRowsForUsage(usage, priceBook) {
  const names = priceBook.comparePresets || [];
  const uniqueNames = [...new Set(names)].filter((name) => !String(name).includes("-free"));
  return uniqueNames
    .map((preset) => {
      const prices = priceForPreset(preset, priceBook);
      const estimated = estimateMiniMaxCost(usage, preset, priceBook);
      if (!prices || estimated === null) return null;
      return {
        model: preset,
        prices_usd_per_million: prices,
        estimated_usd: estimated,
        note: compareNoteCode(preset, priceBook),
        full_note: priceBook.notes?.[preset] || ""
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.estimated_usd - a.estimated_usd);
}

function number(value) {
  return Number(value) || 0;
}
