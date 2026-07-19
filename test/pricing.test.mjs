// test/pricing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estimateMiniMaxCost,
  normalPricePreset,
  priceForPreset,
  compareRowsForUsage,
  normalizePriceBook
} from "../src/pricing.mjs";

const priceBook = normalizePriceBook({
  defaultPreset: "minimax-m3",
  comparePresets: ["minimax-m3", "minimax-m2.7"],
  aliases: { "MiniMax-M3": "minimax-m3" },
  presets: {
    "minimax-m3":   { input: 0.30, cached: 0.06, cacheWrite: 0.375, output: 1.20 },
    "minimax-m2.7": { input: 0.25, cached: 0.05, output: 1.00 }
  }
});

test("normalPricePreset resolves aliases", () => {
  assert.equal(normalPricePreset("MiniMax-M3", priceBook), "minimax-m3");
  assert.equal(normalPricePreset("unknown", priceBook), "unknown");
});

test("priceForPreset returns the preset object or null", () => {
  assert.equal(priceForPreset("minimax-m3", priceBook).input, 0.30);
  assert.equal(priceForPreset("does-not-exist", priceBook), null);
});

test("estimateMiniMaxCost handles a normal input/cache/output mix", () => {
  const usage = { input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0, output: 500_000, reasoning: 0 };
  const cost = estimateMiniMaxCost(usage, "minimax-m3", priceBook);
  // input:    1_000_000 / 1e6 * 0.30  = 0.30
  // cacheRead: 2_000_000 / 1e6 * 0.06 = 0.12
  // output:    500_000 / 1e6 * 1.20 = 0.60
  assert.equal(cost, 1.02);
});

test("estimateMiniMaxCost falls back to input price for cacheWrite when missing", () => {
  const usage = { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0, reasoning: 0 };
  // m2.7 has no cacheWrite → uses input price (0.25)
  const cost = estimateMiniMaxCost(usage, "minimax-m2.7", priceBook);
  assert.equal(cost, 0.25);
});

test("estimateMiniMaxCost includes reasoning in output bill", () => {
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 100_000, reasoning: 100_000 };
  const cost = estimateMiniMaxCost(usage, "minimax-m3", priceBook);
  // 200_000 / 1e6 * 1.20 = 0.24
  assert.equal(cost, 0.24);
});

test("estimateMiniMaxCost returns null when usage is empty or preset is unknown", () => {
  assert.equal(estimateMiniMaxCost(null, "minimax-m3", priceBook), null);
  assert.equal(estimateMiniMaxCost({ input: 1 }, "unknown", priceBook), null);
});

test("compareRowsForUsage sorts by cost desc and skips free aliases", () => {
  const rows = compareRowsForUsage({ input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, priceBook);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, "minimax-m3");
  assert.ok(rows[0].estimated_usd >= rows[1].estimated_usd);
});

test("compareRowsForUsage uses only the saved comparison selection", () => {
  const selected = { ...priceBook, comparePresets: ["minimax-m2.7"] };
  const rows = compareRowsForUsage({ input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, selected);
  assert.deepEqual(rows.map((row) => row.model), ["minimax-m2.7"]);
});

test("normalizePriceBook rejects negative prices", () => {
  assert.throws(() =>
    normalizePriceBook({
      presets: { bad: { input: -1, cached: 0, output: 0 } }
    })
  );
});
