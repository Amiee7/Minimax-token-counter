// src/sources/opencode.mjs
//
// OpenCode SQLite reader (subset of Token-Counter-Tool's opencode source).
// Reads the OpenCode daemon's local SQLite database and produces the same
// payload shape as the MiniMax source, so the dashboard can switch between
// them via a header source switcher.
//
// This variant skips the external `tok.mjs` live tool that the multi-source
// project uses. The dashboard still gets all the data it needs from the DB
// directly.
//
// This app is MiniMax-only. OpenCode Zen and Go are separate source boundaries,
// but every payload is restricted to MiniMax model ids before aggregation.

import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  billingPricePreset,
  compareRowsForUsage,
  estimateMiniMaxCost,
  normalPricePreset,
  priceForPreset
} from "../pricing.mjs";
import {
  addInvalidTimeIssue,
  addIssue,
  addSummary,
  addUnknownModelIssue,
  createQuality,
  finalizeQuality
} from "../quality.mjs";

export const OPENCODE_DB_PATH = process.env.OPENCODE_DB_PATH || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

const MINIMAX_M3_GO_MODEL = { providerID: "opencode-go", id: "minimax-m3" };
const MINIMAX_M3_GO_RATES = { input: 0.3, cacheRead: 0.06, cacheWrite: 0, output: 1.2 };
const MINIMAX_M3_LONG_CONTEXT_THRESHOLD = 200_000;
const PROMOTION_COST_RATIO = 1 / 3;
const COST_RELATIVE_TOLERANCE = 1e-5;
const COST_ABSOLUTE_TOLERANCE = 1e-9;
const MINIMAX_M3_PROMOTION_ID = "minimax-m3-go-3x";
const MINIMAX_M3_PROMOTION_LABEL = "MiniMax M3 (3\u00d7 GO-Aktion)";

export async function loadData(query, priceBook, settings = {}) {
  const params = parseQuery(query, priceBook, settings);
  await ensureDbExists(params.db);

  return withReadonlyDb(params.db, (db) => {
    const rows = readEvents(db, params);

    const total = aggregateTotals(rows);
    const models = aggregateByModel(rows, priceBook, params.billing);
    attachEstimateSummary(total.aggregate, models);
    const history = buildHistory(rows, total, params, priceBook);
    const sessions = buildSessions(rows, params, priceBook);
    const live = buildLiveSnapshot(rows, sessions, params, priceBook);
    const quality = buildQualityReport(rows, models, sessions, total);

    return {
      source: "opencode",
      label: "OpenCode",
      paths: { dataSource: params.db },
      params,
      formulas: {
        total: "input + cache read + cache write + output + reasoning",
        estimate: "input at input price, cache write at cacheWrite (fallback input), cache read at cached, output + reasoning at output",
        sourceTime: "message.time_created from the OpenCode sqlite.db"
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
        kind: "opencode-compare",
        days: params.days,
        source_total: {
          usage: total.aggregate.usage,
          cost: total.aggregate.cost,
          sessions: total.aggregate.sessions,
          events: total.aggregate.events
        },
        formula: "sum of every selected model's price preset",
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
    const latestEvent = readLatestEvent(db, params);
    if (!latestEvent) return buildLiveSnapshot([], { sessions: [] }, params, priceBook);
    const sessionRows = readSessionEvents(db, params, latestEvent.sessionId);
    const sessions = buildSessions(sessionRows, params, priceBook);
    return buildLiveSnapshot([latestEvent], sessions, params, priceBook);
  });
}

// --- internals --------------------------------------------------------------

function parseQuery(query, priceBook, settings) {
  const source = clean(query.get("source")) || "opencode";
  // Default billing depends on the source. Zen aliases free model ids to their
  // paid MiniMax counterpart, while Go keeps its separately published rates.
  const billingFromQuery = clean(query.get("billing"));
  let billing = source === "opencode-zen" ? "zen" : "api";
  if (source === "opencode-go") billing = "go";
  if (billingFromQuery === "go" || billingFromQuery === "zen" || billingFromQuery === "api") {
    billing = billingFromQuery;
  }
  // Zen data has historically used both provider ids. Keep that boundary
  // explicit while the MiniMax model filter remains enforced separately.
  const sourceProviders = source === "opencode-zen"
    ? ["opencode", "opencode-zen"]
    : source === "opencode-go"
    ? ["opencode-go"]
    : clean(query.get("sourceProvider"))
    ? [clean(query.get("sourceProvider"))]
    : [];
  return {
    days: clampInt(query.get("days"), 30, 1, 3650),
    limit: clampInt(query.get("limit"), 100, 1, 500),
    price: query.get("price") || priceBook.defaultPreset,
    db: clean(query.get("db")) || settings.opencodeDbPath || OPENCODE_DB_PATH,
    provider: clean(query.get("provider")),
    model: clean(query.get("model")),
    variant: clean(query.get("variant")),
    source,
    sourceProviders,
    billing
  };
}

async function ensureDbExists(dbPath) {
  try {
    await access(dbPath);
  } catch {
    const error = new Error(`OpenCode database not found at ${dbPath}. Open OpenCode once to create it, or fix the path in Settings.`);
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

function readEvents(db, params) {
  const since = startOfWindowMs(params.days);
  const stmt = db.prepare(`
    select
      m.id as id,
      m.session_id as session_id,
      m.time_created as time_created,
      m.time_updated as time_updated,
      m.data as data,
      s.model as session_model,
      s.title as title,
      s.directory as directory
    from message m
    join session s on s.id = m.session_id
    where m.time_created >= ?
      and m.data like '%"tokens"%'
      and lower(m.data) like '%minimax-%'
    order by m.time_created desc
  `);
  return stmt.all(since)
    .map(normalizeEvent)
    .filter(Boolean)
    .filter((row) => matchesSource(row, params));
}

function readLatestEvent(db, params) {
  const since = startOfWindowMs(params.days);
  const stmt = db.prepare(`
    select
      m.id as id,
      m.session_id as session_id,
      m.time_created as time_created,
      m.time_updated as time_updated,
      m.data as data,
      s.model as session_model,
      s.title as title,
      s.directory as directory
    from message m
    join session s on s.id = m.session_id
    where m.time_created >= ?
      and m.data like '%"tokens"%'
      and lower(m.data) like '%minimax-%'
    order by m.time_created desc
    limit ? offset ?
  `);

  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const rawRows = stmt.all(since, pageSize, offset);
    const event = rawRows
      .map(normalizeEvent)
      .filter(Boolean)
      .find((row) => matchesSource(row, params));
    if (event) return event;
    if (rawRows.length < pageSize) return null;
  }
}

function readSessionEvents(db, params, sessionId) {
  if (!sessionId) return [];
  const stmt = db.prepare(`
    select
      m.id as id,
      m.session_id as session_id,
      m.time_created as time_created,
      m.time_updated as time_updated,
      m.data as data,
      s.model as session_model,
      s.title as title,
      s.directory as directory
    from message m
    join session s on s.id = m.session_id
    where m.session_id = ?
      and m.data like '%"tokens"%'
      and lower(m.data) like '%minimax-%'
    order by m.time_created desc
  `);
  return stmt.all(sessionId)
    .map(normalizeEvent)
    .filter(Boolean)
    .filter((row) => matchesSource(row, params));
}

function normalizeEvent(raw) {
  let data;
  try {
    data = JSON.parse(raw.data);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !data.tokens) return null;

  const sessionModel = parseModel(raw.session_model);
  const eventId = data.modelID || data.model?.id || sessionModel.id;
  const eventProvider = data.providerID || data.model?.providerID || data.model?.provider || sessionModel.providerID;
  const eventVariant = data.variant || data.model?.variant;
  const modelMatchesSession = eventId === sessionModel.id && eventProvider === sessionModel.providerID;
  const model = {
    providerID: eventProvider || "unknown",
    id: eventId || "unknown",
    variant: eventVariant || (modelMatchesSession ? sessionModel.variant : "default") || "default",
    raw: raw.session_model
  };
  const cache = data.tokens.cache || {};
  const usage = {
    input:      Number(data.tokens.input)      || 0,
    output:     Number(data.tokens.output)     || 0,
    reasoning:  Number(data.tokens.reasoning)  || 0,
    cacheRead:  Number(cache.read)             || 0,
    cacheWrite: Number(cache.write)            || 0
  };
  usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  if (usage.total <= 0) return null;

  const event = {
    id: raw.id,
    sessionId: raw.session_id,
    title: raw.title || "",
    directory: raw.directory || "",
    model,
    model_display: modelDisplayName(model),
    cost: Number(data.cost) || 0,
    usage,
    timeCreated: Number(raw.time_created) || 0,
    timeUpdated: Number(raw.time_created || raw.time_updated) || 0
  };
  const costSignature = classifyMiniMaxM3GoCost(event);
  return {
    ...event,
    cost_signature: costSignature,
    promotion: costSignature.status === "promotion"
      ? {
          id: MINIMAX_M3_PROMOTION_ID,
          label: MINIMAX_M3_PROMOTION_LABEL,
          evidence: "local-cost-signature",
          stored_cost_usd: costSignature.stored_cost_usd,
          normal_cost_usd: costSignature.normal_cost_usd,
          ratio: costSignature.ratio
        }
      : null
  };
}

export function normalMiniMaxM3GoCost(usage) {
  const input = finiteNonNegative(usage?.input);
  const cacheRead = finiteNonNegative(usage?.cacheRead);
  const cacheWrite = finiteNonNegative(usage?.cacheWrite);
  const output = finiteNonNegative(usage?.output) + finiteNonNegative(usage?.reasoning);
  const contextTokens = input + cacheRead + cacheWrite;
  const tierMultiplier = contextTokens > MINIMAX_M3_LONG_CONTEXT_THRESHOLD ? 2 : 1;
  return (
    input * MINIMAX_M3_GO_RATES.input * tierMultiplier
    + cacheRead * MINIMAX_M3_GO_RATES.cacheRead * tierMultiplier
    + cacheWrite * MINIMAX_M3_GO_RATES.cacheWrite * tierMultiplier
    + output * MINIMAX_M3_GO_RATES.output * tierMultiplier
  ) / 1_000_000;
}

export function classifyMiniMaxM3GoCost(event) {
  if (
    event?.model?.providerID !== MINIMAX_M3_GO_MODEL.providerID
    || event?.model?.id !== MINIMAX_M3_GO_MODEL.id
  ) {
    return { status: "not-applicable" };
  }

  const normalCost = normalMiniMaxM3GoCost(event.usage);
  const storedCost = finiteNonNegative(event.cost);
  if (normalCost <= 0) {
    return { status: "unclassified", stored_cost_usd: storedCost, normal_cost_usd: normalCost, ratio: null };
  }

  const ratio = storedCost / normalCost;
  if (costApproximatelyEqual(storedCost, normalCost * PROMOTION_COST_RATIO)) {
    return { status: "promotion", stored_cost_usd: storedCost, normal_cost_usd: normalCost, ratio };
  }
  if (costApproximatelyEqual(storedCost, normalCost)) {
    return { status: "normal", stored_cost_usd: storedCost, normal_cost_usd: normalCost, ratio };
  }
  return { status: "unclassified", stored_cost_usd: storedCost, normal_cost_usd: normalCost, ratio };
}

function costApproximatelyEqual(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(
    COST_ABSOLUTE_TOLERANCE,
    Math.abs(expected) * COST_RELATIVE_TOLERANCE
  );
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, 0) : 0;
}

function parseModel(value) {
  if (!value) return { providerID: "unknown", id: "unknown", variant: "default", raw: "" };
  try {
    const parsed = JSON.parse(value);
    return {
      providerID: parsed.providerID || parsed.provider || "unknown",
      id: parsed.id || parsed.modelID || "unknown",
      variant: parsed.variant || "default",
      raw: value
    };
  } catch {
    return { providerID: "unknown", id: value, variant: "default", raw: value };
  }
}

function modelDisplayName(model) {
  if (!model) return "unknown/unknown/default";
  return `${model.providerID || "unknown"}/${model.id || "unknown"}/${model.variant || "default"}`;
}

function matchesFilters(row, params) {
  if (params.provider && row.model.providerID !== params.provider) return false;
  if (params.model && row.model.id !== params.model) return false;
  if (params.variant && row.model.variant !== params.variant) return false;
  return true;
}

function matchesSource(row, params) {
  if (!isMinimaxModelId(row.model?.id)) return false;
  const sourceProviders = Array.isArray(params.sourceProviders)
    ? params.sourceProviders
    : params.sourceProvider
    ? [params.sourceProvider]
    : [];
  if (sourceProviders.length && !sourceProviders.includes(row.model?.providerID)) return false;
  return matchesFilters(row, params);
}

function isMinimaxModelId(id) {
  const text = String(id || "").toLowerCase();
  return text === "minimax" || text.startsWith("minimax-");
}

// --- aggregation ------------------------------------------------------------

function aggregateTotals(rows) {
  const bucket = makeBucket();
  for (const row of rows) addToBucket(bucket, row);
  return { aggregate: finaliseBucket(bucket) };
}

function aggregateByModel(rows, priceBook, billing) {
  const byKey = new Map();
  for (const row of rows) {
    const key = eventGroupKey(row);
    if (!byKey.has(key)) {
      byKey.set(key, {
        ...makeBucket(),
        key: row.model_display,
        model: row.model,
        model_display: row.model_display,
        promotion: row.promotion || null
      });
    }
    addToBucket(byKey.get(key), row);
  }
  return [...byKey.values()]
    .map((row) => withEstimate(finaliseBucket(row), priceBook, billing))
    .sort((a, b) => (b.usage?.total || 0) - (a.usage?.total || 0));
}

function withEstimate(row, priceBook, billing) {
  const modelKey = row.model?.id || row.model_display;
  const preset = billingPricePreset(modelKey, billing, priceBook);
  const estimated = row?.cost_signature_summary?.events > 0
    ? row.cost_signature_summary.normal_cost_usd
    : ["promotion", "normal"].includes(row?.cost_signature?.status)
    ? row.cost_signature.normal_cost_usd
    : preset ? estimateMiniMaxCost(row.usage, preset, priceBook) : null;
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
    kind: "opencode-history",
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
    const mkey = eventGroupKey(row);
    if (!models.has(mkey)) models.set(mkey, {
      ...makeBucket(),
      model: row.model,
      model_display: row.model_display,
      promotion: row.promotion || null
    });
    addToBucket(models.get(mkey), row);
  }

  const entries = fixedKeys
    ? fixedKeys.map((k) => [k, periods.get(k) || makeBucket()])
    : [...periods.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  return entries.map(([period, bucket]) => ({
    period,
    ...withEstimate(finaliseBucket(bucket), priceBook, params.billing),
    models: [...(modelByPeriod.get(period)?.values() || [])]
      .map((m) => withEstimate(finaliseBucket(m), priceBook, params.billing))
      .sort((a, b) => (b.usage?.total || 0) - (a.usage?.total || 0))
  }));
}

// --- sessions ---------------------------------------------------------------

function buildSessions(rows, params, priceBook) {
  const bySession = new Map();
  for (const row of rows) {
    const sessionId = row.sessionId || `event-${row.id}`;
    const key = `${sessionId}${promotionGroupSuffix(row)}`;
    if (!bySession.has(key)) {
      bySession.set(key, {
        ...makeBucket(),
        id: sessionId,
        title: row.title,
        directory: row.directory,
        model: row.model,
        model_display: row.model_display,
        timeCreated: row.timeCreated,
        timeUpdated: row.timeUpdated,
        promotion: row.promotion || null
      });
    }
    const session = bySession.get(key);
    addToBucket(session, row);
    session.timeCreated = Math.min(session.timeCreated || row.timeCreated, row.timeCreated || session.timeCreated);
    session.timeUpdated = Math.max(session.timeUpdated || 0, row.timeUpdated || row.timeCreated || 0);
  }
  return {
    kind: "opencode-sessions",
    days: params.days,
    dbPath: params.db,
    sessions: [...bySession.values()]
      .map((session) => withEstimate(finaliseBucket(session), priceBook, params.billing))
      .sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0))
      .slice(0, params.limit)
  };
}

// --- live snapshot ----------------------------------------------------------

function buildLiveSnapshot(rows, sessionsPayload, params, priceBook) {
  const latestEvent = rows[0]
    ? withEstimate({
        ...rows[0],
        estimated_usd: estimateMiniMaxCost(rows[0].usage, params.price, priceBook)
      }, priceBook, params.billing)
    : null;
  const session = latestEvent
    ? (sessionsPayload?.sessions || []).find((s) => (
        s.id === latestEvent.sessionId
        && (s.promotion?.id || null) === (latestEvent.promotion?.id || null)
      )) || null
    : null;

  return {
    latestEvent,
    session,
    liveSource: {
      latestEvent: "most recent message with tokens in OpenCode sqlite.db",
      session: "session table aggregate, most recently updated"
    }
  };
}

// --- quality ----------------------------------------------------------------

function buildQualityReport(rows, models, sessions, total) {
  const quality = createQuality("opencode");
  addSummary(quality, "events", rows.length);
  addSummary(quality, "sessions", total?.aggregate?.sessions || sessions.sessions?.length || 0);
  addSummary(quality, "models", models.length);
  addMissingPriceIssue(quality, models, "total");
  addInvalidTimeIssue(quality, rows, "OpenCode event");
  addUnknownModelIssue(quality, rows);

  const mismatchCount = rows.filter((row) => !usageSumsMatch(row.usage)).length;
  if (mismatchCount > 0) {
    addSummary(quality, "sum_mismatch_rows", mismatchCount);
    addIssue(quality, "warning", "sum-mismatch", `${mismatchCount} row(s) have component totals that do not match total.`, { count: mismatchCount });
  }
  return finalizeQuality(quality);
}

function addMissingPriceIssue(quality, rows, tokenField = "total") {
  const missing = (rows || []).filter((row) => row.estimate_missing_price);
  if (!missing.length) return;
  const tokens = missing.reduce((sum, row) => sum + (Number(row.usage?.[tokenField]) || 0), 0);
  addSummary(quality, "missing_price_models", missing.length);
  addSummary(quality, "missing_price_tokens", tokens);
  addIssue(
    quality,
    "warning",
    "missing-price",
    `${missing.length} model price preset(s) are missing.`,
    {
      count: missing.length,
      tokens,
      models: missing.map((row) => row.model_display || row.normal_price_preset || row.key || "unknown")
    }
  );
}

function usageSumsMatch(usage) {
  if (!usage) return true;
  const sum = (Number(usage.input) || 0) + (Number(usage.output) || 0) + (Number(usage.reasoning) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  return sum === (Number(usage.total) || 0);
}

// --- bucket helpers ---------------------------------------------------------

function makeBucket() {
  return {
    sessions: new Set(),
    promotionSessions: new Set(),
    events: 0,
    cost: 0,
    promotion: null,
    promotion_summary: { events: 0, sessions: 0, usage_total: 0, stored_cost_usd: 0, normal_cost_usd: 0 },
    cost_signature_summary: { events: 0, stored_cost_usd: 0, normal_cost_usd: 0 },
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    lastUsed: 0
  };
}

function addToBucket(bucket, row) {
  bucket.events += 1;
  if (row.sessionId) bucket.sessions.add(row.sessionId);
  bucket.cost += Number(row.cost) || 0;
  if (["promotion", "normal"].includes(row.cost_signature?.status)) {
    bucket.cost_signature_summary.events += 1;
    bucket.cost_signature_summary.stored_cost_usd += Number(row.cost_signature.stored_cost_usd) || 0;
    bucket.cost_signature_summary.normal_cost_usd += Number(row.cost_signature.normal_cost_usd) || 0;
  }
  if (row.promotion) {
    bucket.promotion = row.promotion;
    if (row.sessionId) bucket.promotionSessions.add(row.sessionId);
    bucket.promotion_summary.events += 1;
    bucket.promotion_summary.stored_cost_usd += Number(row.promotion.stored_cost_usd) || 0;
    bucket.promotion_summary.normal_cost_usd += Number(row.promotion.normal_cost_usd) || 0;
    bucket.promotion_summary.usage_total += Number(row.usage?.total) || 0;
  }
  for (const key of Object.keys(bucket.usage)) {
    bucket.usage[key] += Number(row.usage?.[key]) || 0;
  }
  bucket.lastUsed = Math.max(bucket.lastUsed || 0, row.timeUpdated || row.timeCreated || 0);
}

function finaliseBucket(bucket) {
  const { promotionSessions, ...clean } = bucket;
  return {
    ...clean,
    sessions: bucket.sessions instanceof Set ? bucket.sessions.size : bucket.sessions,
    promotion_summary: bucket.promotion_summary?.events > 0
      ? { ...bucket.promotion_summary, sessions: promotionSessions?.size || 0 }
      : null,
    cost_signature_summary: bucket.cost_signature_summary?.events > 0
      ? bucket.cost_signature_summary
      : null
  };
}

function eventGroupKey(row) {
  return `${row.model_display}${promotionGroupSuffix(row)}`;
}

function promotionGroupSuffix(row) {
  return row?.promotion?.id ? `::${row.promotion.id}` : "::standard";
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
