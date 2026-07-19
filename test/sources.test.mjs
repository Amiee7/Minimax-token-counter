import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { loadData as loadMiniMaxData, loadLive as loadMiniMaxLive } from "../src/sources/minimax.mjs";
import {
  classifyMiniMaxM3GoCost,
  loadData as loadOpenCodeData,
  loadLive as loadOpenCodeLive,
  normalMiniMaxM3GoCost
} from "../src/sources/opencode.mjs";

const priceBook = {
  defaultPreset: "minimax-m3",
  comparePresets: ["minimax-m3", "opencode-go/minimax-m3"],
  aliases: {
    "MiniMax-M3": "minimax-m3",
    "minimax-m3-free": "minimax-m3",
    "minimax-m2.5-free": "minimax-m2.5"
  },
  notes: {},
  presets: {
    "minimax-m3": { input: 0.3, cached: 0.06, cacheWrite: 0.375, output: 1.2 },
    "opencode-go/minimax-m3": { input: 0.3, cached: 0.06, cacheWrite: 0, output: 1.2 },
    "opencode-zen/minimax-m3": { input: 0.3, cached: 0.06, cacheWrite: 0, output: 1.2 },
    "opencode-zen/minimax-m2.5": { input: 0.3, cached: 0.06, cacheWrite: 0, output: 1.2 }
  }
};

test("MiniMax source keeps session metadata and component totals", async (t) => {
  const { dir, dbPath } = await createMiniMaxDb();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const query = new URLSearchParams({ days: "30", limit: "100" });

  const data = await loadMiniMaxData(query, priceBook, { minimaxDbPath: dbPath });
  assert.equal(data.events.total.events, 2);
  assert.equal(data.events.total.usage.total, 188);
  assert.equal(data.sessions.sessions.length, 1);
  assert.equal(data.sessions.sessions[0].id, "mini-session");
  assert.equal(data.sessions.sessions[0].title, "MiniMax test");

  const live = await loadMiniMaxLive(query, priceBook, { minimaxDbPath: dbPath });
  assert.equal(live.latestEvent.id, 2);
  assert.equal(live.session.id, "mini-session");
  assert.equal(live.session.events, 2);
});

test("OpenCode Zen and Go expose only MiniMax events from their provider", async (t) => {
  const { dir, dbPath } = await createOpenCodeDb();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const zenQuery = new URLSearchParams({ days: "30", source: "opencode-zen", limit: "100" });
  const zen = await loadOpenCodeData(zenQuery, priceBook, { opencodeDbPath: dbPath });
  assert.equal(zen.events.total.events, 2);
  assert.equal(zen.events.models.length, 2);
  assert.equal(zen.events.models.every((row) => ["opencode", "opencode-zen"].includes(row.model.providerID)), true);
  assert.equal(zen.events.models.every((row) => row.model.id.startsWith("minimax-")), true);
  assert.equal(zen.events.total.estimate_complete, true);
  assert.deepEqual(zen.sessions.sessions.map((row) => row.id), ["zen-managed-mini", "zen-mini"]);

  const goQuery = new URLSearchParams({ days: "30", source: "opencode-go", billing: "go", limit: "100" });
  const go = await loadOpenCodeData(goQuery, priceBook, { opencodeDbPath: dbPath });
  assert.equal(go.events.total.events, 2);
  assert.equal(go.events.models.every((row) => row.model.providerID === "opencode-go"), true);
  assert.equal(go.events.total.promotion_summary.events, 1);
  assert.equal(go.events.total.promotion_summary.usage_total, 300);
  assert.equal(go.events.models.find((row) => row.promotion)?.promotion.id, "minimax-m3-go-3x");
  assert.deepEqual(go.sessions.sessions.map((row) => row.id), ["go-mini", "go-mini"]);
  assert.equal(go.sessions.sessions.filter((row) => row.promotion).length, 1);

  const live = await loadOpenCodeLive(goQuery, priceBook, { opencodeDbPath: dbPath });
  assert.equal(live.latestEvent.sessionId, "go-mini");
  assert.equal(live.session.id, "go-mini");
  assert.equal(live.latestEvent.promotion.id, "minimax-m3-go-3x");
});

test("MiniMax M3 GO recognizes only the one-third local promotion signature", () => {
  const usage = { input: 1_000, output: 100, reasoning: 0, cacheRead: 9_000, cacheWrite: 0, total: 10_100 };
  const normalCost = normalMiniMaxM3GoCost(usage);
  const event = { model: { providerID: "opencode-go", id: "minimax-m3" }, usage, cost: normalCost / 3 };

  assert.equal(classifyMiniMaxM3GoCost(event).status, "promotion");
  assert.equal(classifyMiniMaxM3GoCost({ ...event, cost: normalCost }).status, "normal");
  assert.equal(classifyMiniMaxM3GoCost({
    ...event,
    model: { providerID: "opencode", id: "minimax-m3" }
  }).status, "not-applicable");
});

test("MiniMax M3 GO normal price doubles only above 200000 context tokens", () => {
  const usage = { input: 1_000, output: 0, reasoning: 0, cacheRead: 200_000, cacheWrite: 0, total: 201_000 };
  const baseCost = (1_000 * 0.3 + 200_000 * 0.06) / 1_000_000;
  assert.equal(normalMiniMaxM3GoCost(usage), baseCost * 2);
});

async function createMiniMaxDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "minimax-source-test-"));
  const dbPath = path.join(dir, "sqlite.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table sessions (
      session_id text primary key, title text, workspace_dir text, status text,
      effective_model text, effective_model_variant text, created_at integer, updated_at integer
    );
    create table token_usage (
      id integer primary key, session_id text, agent_name text, framework_type text,
      turn_id text, model text, ts integer, input_tokens integer, output_tokens integer,
      reasoning_tokens integer, cache_read_tokens integer, cache_write_tokens integer,
      cost_usd real, raw text
    );
  `);
  const now = Date.now();
  db.prepare("insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("mini-session", "MiniMax test", "C:\\work", "done", "MiniMax-M3", "default", now - 1000, now);
  const insert = db.prepare("insert into token_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(1, "mini-session", "agent", "minimax", "turn-1", "minimax/MiniMax-M3", now - 500, 20, 3, 0, 50, 0, 0.01, "{}");
  insert.run(2, "mini-session", "agent", "minimax", "turn-2", "minimax/MiniMax-M3", now, 10, 5, 0, 100, 0, 0.02, "{}");
  db.close();
  return { dir, dbPath };
}

async function createOpenCodeDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-source-test-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (id text primary key, title text, directory text, model text);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
  `);
  const now = Date.now();
  const add = (id, providerID, modelID, total, time, cost = 0) => {
    db.prepare("insert into session values (?, ?, ?, ?)").run(id, id, "C:\\work", JSON.stringify({ providerID, id: modelID, variant: "default" }));
    db.prepare("insert into message values (?, ?, ?, ?, ?)").run(`${id}-message`, id, time, time, JSON.stringify({
      providerID,
      modelID,
      variant: "default",
      tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost
    }));
  };
  add("zen-mini", "opencode", "minimax-m3-free", 100, now - 300);
  add("zen-mimo", "opencode", "mimo-v2.5-free", 200, now - 200);
  add("zen-managed-mini", "opencode-zen", "minimax-m2.5", 80, now - 250);
  add("zen-foreign", "opencode-zen", "qwen3.7-plus", 150, now - 225);
  add("go-mini", "opencode-go", "minimax-m3", 300, now - 100, 0.00003);
  db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
    "go-mini-normal-message",
    "go-mini",
    now - 150,
    now - 150,
    JSON.stringify({
      providerID: "opencode-go",
      modelID: "minimax-m3",
      variant: "default",
      tokens: { input: 300, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.00009
    })
  );
  db.close();
  return { dir, dbPath };
}
