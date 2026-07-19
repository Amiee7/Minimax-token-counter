// src/sources/minimax.mjs
//
// Reads the MiniMax Code daemon's local SQLite database and produces the
// payload the dashboard needs:
//
//   loadData(...)  → full dashboard payload (history / models / sessions / compare / quality)
//   loadLive(...)  → small snapshot for the auto-refreshing "Live" tab
//
// Schema facts (from ~/.minimax/sqlite.db):
//   token_usage(
//     id, session_id, agent_name, framework_type, turn_id, model, ts,
//     input_tokens, output_tokens, reasoning_tokens,
//     cache_read_tokens, cache_write_tokens, cost_usd, raw
//   )
//   sessions(
//     session_id, agent_name, title, workspace_dir, status, framework_type,
//     effective_model, effective_model_variant, created_at, updated_at, ...
//   )
//
// `model` is stored either as a free string ("MiniMax-M3") or as a
// "provider/model/variant" triple. The dashboard always renders the triple.

import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  compareRowsForUsage,
  estimateMiniMaxCost,
  normalPricePreset,
  priceForPreset
} from "../pricing.mjs";
import {
  addInvalidTimeIssue,
  addIssue,
  addMissingPriceIssue,
  addSummary,
  addUnknownModelIssue,
  createQuality,
  finalizeQuality
} from "../quality.mjs";

// Defaults match the live install. Both are overridable via the settings panel.
export const MINIMAX_HOME = process.env.MINIMAX_HOME || path.join(os.homedir(), ".minimax");
export const MINIMAX_DB_PATH = process.env.MINIMAX_DB_PATH || path.join(MINIMAX_HOME, "sqlite.db");

export async function loadData(query, priceBook, settings = {}) {
  const params = parseQuery(query, priceBook, settings);
  await ensureDbExists(params.db);

  return withReadonlyDb(params.db, (db) => {
    const rows = readUsageRows(db, params);

    const total = aggregateTotals(rows);
    const models = aggregateByModel(rows, priceBook);
    attachEstimateSummary(total.aggregate, models);
    const history = buildHistory(rows, total, params, priceBook);
    const sessions = buildSessions(rows, params, priceBook);
    const live = buildLiveSnapshot(rows, params, priceBook);
    const quality = buildQualityReport(rows, models, sessions, total);

    return {
      source: "minimax",
      label: "MiniMax Code",
      paths: { dataSource: params.db },
      params,
      formulas: {
        total: "input + cache read + cache write + output + reasoning",
        estimate: "input at input price, cache write at cacheWrite (fallback input), cache read at cached, output + reasoning at output",
        sourceTime: "token_usage.ts from the MiniMax sqlite.db"
      },
      events: {
        dbPath: params.db,
        days: params.days,
        total: total.aggregate,
        models
      },
      history,
      sessions,
      live,
      quality,
      compare: {
        kind: "minimax-compare",
        days: params.days,
        source_total: {
          usage: total.aggregate.usage,
          cost: total.aggregate.cost,
          sessions: total.aggregate.sessions,
          events: total.aggregate.events
        },
        formula: "input + cache write at input price, cache read at cached price, output + reasoning at output price",
        models: compareRowsForUsage(total.aggregate.usage, priceBook)
      },
      errors: {}
    };
  });
}

export async function loadLive(query, priceBook, settings = {}) {
  const params = parseQuery(query, priceBook, settings);
  await ensureDbExists(params.db);

  return withReadonlyDb(params.db, (db) => {
    const latestEvent = readLatestUsageRow(db, params);
    if (!latestEvent) return buildLiveSnapshot([], params, priceBook);
    const sessionRows = readSessionUsageRows(db, params, latestEvent.sessionId);
    return buildLiveSnapshot(sessionRows, params, priceBook);
  });
}

// --- internals --------------------------------------------------------------

function parseQuery(query, priceBook, settings) {
  return {
    days: clampInt(query.get("days"), 30, 1, 3650),
    limit: clampInt(query.get("limit"), 100, 1, 500),
    price: query.get("price") || priceBook.defaultPreset,
    db: clean(query.get("db")) || settings.minimaxDbPath || MINIMAX_DB_PATH,
    provider: clean(query.get("provider")),
    model: clean(query.get("model")),
    variant: clean(query.get("variant"))
  };
}

async function ensureDbExists(dbPath) {
  try {
    await access(dbPath);
  } catch {
    const error = new Error(`MiniMax database not found at ${dbPath}. Open MiniMax Code once to create it, or fix the path in Settings.`);
    error.code = "DB_NOT_FOUND";
    throw error;
  }
}

async function withReadonlyDb(dbPath, fn) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("pragma busy_timeout = 5000");
      return fn(db);
    } catch (error) {
      lastError = error;
      if (!isSqliteBusy(error) || attempt === 4) throw error;
      await sleep(150 * (attempt + 1));
    } finally {
      if (db) db.close();
    }
  }
  throw lastError;
}

function readUsageRows(db, params) {
  const since = startOfWindowMs(params.days);
  const stmt = db.prepare(`
    select
      u.id, u.session_id, u.agent_name, u.framework_type, u.turn_id,
      u.model, u.ts,
      u.input_tokens, u.output_tokens, u.reasoning_tokens,
      u.cache_read_tokens, u.cache_write_tokens,
      u.cost_usd, u.raw,
      s.title, s.workspace_dir, s.status,
      s.effective_model, s.effective_model_variant,
      s.created_at as session_created_at,
      s.updated_at as session_updated_at
    from token_usage u
    left join sessions s on s.session_id = u.session_id
    where u.ts >= ?
    order by u.ts desc
  `);
  return stmt.all(since)
    .map(normalizeRow)
    .filter((row) => matchesFilters(row, params));
}

function readLatestUsageRow(db, params) {
  const since = startOfWindowMs(params.days);
  const stmt = db.prepare(`
    select
      u.id, u.session_id, u.agent_name, u.framework_type, u.turn_id,
      u.model, u.ts,
      u.input_tokens, u.output_tokens, u.reasoning_tokens,
      u.cache_read_tokens, u.cache_write_tokens,
      u.cost_usd, u.raw,
      s.title, s.workspace_dir, s.status,
      s.effective_model, s.effective_model_variant,
      s.created_at as session_created_at,
      s.updated_at as session_updated_at
    from token_usage u
    left join sessions s on s.session_id = u.session_id
    where u.ts >= ?
    order by u.ts desc
    limit ? offset ?
  `);
  const pageSize = 250;
  for (let offset = 0; ; offset += pageSize) {
    const rawRows = stmt.all(since, pageSize, offset);
    const event = rawRows.map(normalizeRow).find((row) => matchesFilters(row, params));
    if (event) return event;
    if (rawRows.length < pageSize) return null;
  }
}

function readSessionUsageRows(db, params, sessionId) {
  if (!sessionId) return [];
  const stmt = db.prepare(`
    select
      u.id, u.session_id, u.agent_name, u.framework_type, u.turn_id,
      u.model, u.ts,
      u.input_tokens, u.output_tokens, u.reasoning_tokens,
      u.cache_read_tokens, u.cache_write_tokens,
      u.cost_usd, u.raw,
      s.title, s.workspace_dir, s.status,
      s.effective_model, s.effective_model_variant,
      s.created_at as session_created_at,
      s.updated_at as session_updated_at
    from token_usage u
    left join sessions s on s.session_id = u.session_id
    where u.session_id = ?
    order by u.ts desc
  `);
  return stmt.all(sessionId).map(normalizeRow).filter((row) => matchesFilters(row, params));
}

function normalizeRow(raw) {
  const model = parseModel(raw.model || raw.effective_model);
  const usage = {
    input:      Number(raw.input_tokens)       || 0,
    output:     Number(raw.output_tokens)      || 0,
    reasoning:  Number(raw.reasoning_tokens)   || 0,
    cacheRead:  Number(raw.cache_read_tokens)  || 0,
    cacheWrite: Number(raw.cache_write_tokens) || 0
  };
  usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  return {
    id: raw.id,
    sessionId: raw.session_id,
    turnId: raw.turn_id || "",
    agentName: raw.agent_name || "",
    frameworkType: raw.framework_type || "",
    title: raw.title || raw.agent_name || "",
    directory: raw.workspace_dir || "",
    status: raw.status || "",
    model,
    model_display: modelDisplayName(model),
    cost: Number(raw.cost_usd) || 0,
    usage,
    raw: raw.raw || "",
    timeCreated: Number(raw.ts) || 0,
    timeUpdated: Number(raw.ts) || Number(raw.session_updated_at) || 0
  };
}

function parseModel(value) {
  const text = String(value || "MiniMax-M3").trim();
  if (text.includes("/")) {
    const [provider, id, variant = "default"] = text.split("/");
    return { providerID: provider || "minimax", id: id || "unknown", variant, raw: text };
  }
  return { providerID: "minimax", id: text || "unknown", variant: "default", raw: text };
}

function modelDisplayName(model) {
  return `${model.providerID || "minimax"}/${model.id || "unknown"}/${model.variant || "default"}`;
}

function matchesFilters(row, params) {
  if (params.provider && row.model.providerID !== params.provider) return false;
  if (params.model && row.model.id !== params.model) return false;
  if (params.variant && row.model.variant !== params.variant) return false;
  return true;
}

// --- aggregation ------------------------------------------------------------

function aggregateTotals(rows) {
  const acc = {
    sessions: new Set(),
    events: 0,
    cost: 0,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    lastUsed: 0
  };
  for (const row of rows) {
    acc.events += 1;
    if (row.sessionId) acc.sessions.add(row.sessionId);
    acc.cost += row.cost || 0;
    for (const key of Object.keys(acc.usage)) {
      acc.usage[key] += Number(row.usage?.[key]) || 0;
    }
    acc.lastUsed = Math.max(acc.lastUsed, row.timeUpdated || row.timeCreated || 0);
  }
  return {
    aggregate: {
      sessions: acc.sessions.size,
      events: acc.events,
      cost: acc.cost,
      usage: acc.usage,
      lastUsed: acc.lastUsed
    }
  };
}

function aggregateByModel(rows, priceBook) {
  const byKey = new Map();
  for (const row of rows) {
    const key = row.model_display;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        model: row.model,
        model_display: key,
        sessions: new Set(),
        events: 0,
        cost: 0,
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        lastUsed: 0
      });
    }
    const acc = byKey.get(key);
    acc.events += 1;
    if (row.sessionId) acc.sessions.add(row.sessionId);
    acc.cost += row.cost || 0;
    for (const k of Object.keys(acc.usage)) acc.usage[k] += Number(row.usage?.[k]) || 0;
    acc.lastUsed = Math.max(acc.lastUsed, row.timeUpdated || row.timeCreated || 0);
  }
  return [...byKey.values()]
    .map((row) => withEstimate(row, priceBook))
    .sort((a, b) => (b.usage?.total || 0) - (a.usage?.total || 0));
}

function withEstimate(row, priceBook) {
  const preset = normalPricePreset(row.model?.id || row.model_display, priceBook);
  const estimated = preset ? estimateMiniMaxCost(row.usage, preset, priceBook) : null;
  const sessionCount = row.sessions instanceof Set
    ? row.sessions.size
    : Number.isFinite(row.sessions) ? row.sessions : 0;
  return {
    ...row,
    sessions: sessionCount,
    normal_price_preset: preset,
    normal_estimated_usd: estimated,
    estimate_missing_price: !preset || !priceForPreset(preset, priceBook)
  };
}

function attachEstimateSummary(total, models) {
  const sum = models.reduce((acc, row) => (
    Number.isFinite(row.normal_estimated_usd) ? acc + row.normal_estimated_usd : acc
  ), 0);
  const missing = models.filter((row) => row.estimate_missing_price);
  total.normal_estimated_usd = Number.isFinite(sum) ? sum : null;
  total.estimate_complete = missing.length === 0;
  total.estimate_missing_models = missing.map((row) => row.model_display);
  total.estimate_missing_tokens = missing.reduce((acc, row) => acc + (Number(row.usage?.total) || 0), 0);
}

// --- history ----------------------------------------------------------------

function buildHistory(rows, total, params, priceBook) {
  return {
    kind: "minimax-history",
    days: params.days,
    price_preset: params.price,
    week_periods: groupBy(rows, weekKey, params, priceBook),
    day_periods: groupBy(rows, dayKey, params, priceBook, recentDayKeys(params.days)),
    total: total.aggregate
  };
}

function groupBy(rows, keyFn, params, priceBook, fixedKeys = null) {
  const periods = new Map();
  const modelByPeriod = new Map();

  for (const row of rows) {
    const period = keyFn(row.timeCreated || row.timeUpdated);
    if (!periods.has(period)) {
      periods.set(period, makeBucket());
      modelByPeriod.set(period, new Map());
    }
    addToBucket(periods.get(period), row);

    const models = modelByPeriod.get(period);
    const mkey = row.model_display;
    if (!models.has(mkey)) models.set(mkey, { ...makeBucket(), model: row.model, model_display: mkey });
    addToBucket(models.get(mkey), row);
  }

  const entries = fixedKeys
    ? fixedKeys.map((k) => [k, periods.get(k) || makeBucket()])
    : [...periods.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  return entries.map(([period, bucket]) => ({
    period,
    ...withEstimate(finaliseBucket(bucket), priceBook),
    models: [...(modelByPeriod.get(period)?.values() || [])]
      .map((m) => withEstimate(finaliseBucket(m), priceBook))
      .sort((a, b) => (b.usage?.total || 0) - (a.usage?.total || 0))
  }));
}

// --- sessions ---------------------------------------------------------------

function buildSessions(rows, params, priceBook) {
  const sessions = new Map();
  for (const row of rows) {
    const key = row.sessionId || `row-${row.id}`;
    if (!sessions.has(key)) {
      sessions.set(key, {
        ...makeBucket(),
        id: key,
        sessionId: row.sessionId,
        title: row.title,
        directory: row.directory,
        agentName: row.agentName,
        status: row.status,
        model: row.model,
        model_display: row.model_display,
        timeCreated: row.timeCreated,
        timeUpdated: row.timeUpdated
      });
    }
    const session = sessions.get(key);
    addToBucket(session, row);
    session.timeCreated = Math.min(session.timeCreated || row.timeCreated, row.timeCreated || session.timeCreated);
    session.timeUpdated = Math.max(session.timeUpdated || 0, row.timeUpdated || row.timeCreated || 0);
  }

  return {
    kind: "minimax-sessions",
    days: params.days,
    dbPath: params.db,
    sessions: [...sessions.values()]
      .map((s) => withEstimate(finaliseBucket(s), priceBook))
      .sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0))
      .slice(0, params.limit)
  };
}

// --- live snapshot ----------------------------------------------------------

function buildLiveSnapshot(rows, params, priceBook) {
  const latestEvent = rows[0] || null;
  const latestSession = latestEvent
    ? buildSessions(rows.filter((r) => r.sessionId === latestEvent.sessionId), params, priceBook).sessions[0] || null
    : null;

  return {
    latestEvent: latestEvent
      ? withEstimate({
          ...latestEvent,
          estimated_usd: estimateMiniMaxCost(latestEvent.usage, params.price, priceBook)
        }, priceBook)
      : null,
    session: latestSession,
    liveSource: {
      latestEvent: "most recent row in token_usage",
      session: "token_usage grouped by session_id, most recently updated"
    }
  };
}

// --- quality ----------------------------------------------------------------

function buildQualityReport(rows, models, sessions, total) {
  const quality = createQuality("minimax");
  addSummary(quality, "events", rows.length);
  addSummary(quality, "sessions", total?.aggregate?.sessions || sessions.sessions?.length || 0);
  addSummary(quality, "models", models.length);
  addMissingPriceIssue(quality, models, "total");
  addInvalidTimeIssue(quality, rows, "MiniMax token_usage");
  addUnknownModelIssue(quality, rows);

  const mismatchCount = rows.filter((row) => !rowUsageSumsMatch(row.usage)).length;
  if (mismatchCount > 0) {
    addSummary(quality, "sum_mismatch_rows", mismatchCount);
    addIssue(quality, "warning", "sum-mismatch", `${mismatchCount} row(s) have component totals that do not match total.`, { count: mismatchCount });
  }
  return finalizeQuality(quality);
}

function rowUsageSumsMatch(usage) {
  if (!usage) return true;
  const sum = (Number(usage.input) || 0) + (Number(usage.output) || 0) + (Number(usage.reasoning) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  return sum === (Number(usage.total) || 0);
}

// --- bucket helpers ---------------------------------------------------------

function makeBucket() {
  return {
    sessions: new Set(),
    events: 0,
    cost: 0,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    lastUsed: 0
  };
}

function addToBucket(bucket, row) {
  bucket.events += 1;
  if (row.sessionId) bucket.sessions.add(row.sessionId);
  bucket.cost += Number(row.cost) || 0;
  for (const key of Object.keys(bucket.usage)) {
    bucket.usage[key] += Number(row.usage?.[key]) || 0;
  }
  bucket.lastUsed = Math.max(bucket.lastUsed || 0, row.timeUpdated || row.timeCreated || 0);
}

function finaliseBucket(bucket) {
  return {
    ...bucket,
    sessions: bucket.sessions instanceof Set ? bucket.sessions.size : bucket.sessions,
  };
}

// --- date helpers -----------------------------------------------------------

function startOfWindowMs(days) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return start.getTime();
}

function recentDayKeys(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(dayKeyFromDate(d));
  }
  return out;
}

function dayKey(ms) {
  const date = new Date(Number(ms) || 0);
  if (Number.isNaN(date.getTime())) return "unknown";
  return dayKeyFromDate(date);
}

function weekKey(ms) {
  const date = new Date(Number(ms) || 0);
  if (Number.isNaN(date.getTime())) return "unknown";
  const day = date.getDay() || 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return `${dayKeyFromDate(monday)}..${dayKeyFromDate(sunday)}`;
}

function dayKeyFromDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

// --- input helpers ----------------------------------------------------------

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function isSqliteBusy(error) {
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error?.message || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
