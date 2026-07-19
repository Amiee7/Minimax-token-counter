// public/app.js
//
// MiniMax-only dashboard with three source boundaries: MiniMax App,
// MiniMax through OpenCode Zen, and MiniMax through OpenCode Go.
// Renders 7 tabs from the JSON payload delivered by /api/<source>.
//
// OpenCode-backed sources are restricted to MiniMax model ids in the backend.

const TABS = ["Overview", "Live", "Models", "History", "Compare", "Sessions", "Settings"];
const CACHE_PREFIX = "minimax-token-counter-cache-v2:";
const UI_STATE_KEY = "minimax-token-counter-ui-v1";

const state = {
  source: "minimax",
  tab: "Overview",
  days: 30,
  price: "minimax-m3",
  modelFilter: "all",
  modelOptions: [],
  liveTimer: null,
  liveInflight: false,
  loadRequestId: 0,
  liveRequestId: 0,
  responseCache: new Map(),
  liveCache: new Map(),
  activeCacheKey: "",
  config: null,
  data: null,
  loading: false,
  search: ""
};

const els = {
  content:     document.getElementById("content"),
  tabs:        document.getElementById("tabs"),
  modelFilter: document.getElementById("modelFilter"),
  sourceSelect: document.getElementById("sourceSelect"),
  customDays:  document.getElementById("customDays"),
  pathButton:  document.getElementById("pathButton"),
  refreshBtn:  document.getElementById("refreshButton")
};

init().catch((err) => {
  els.content.innerHTML = `<section class="panel"><div class="error-box">${escapeHtml(err.message)}</div></section>`;
});

// ---------------------------------------------------------------------------
// bootstrap

async function init() {
  restoreUiState();
  state.config = await fetchJson("/api/config");
  state.price  = state.config.priceBook.defaultPreset || state.price;
  renderModelOptions();
  bindEvents();
  renderTabs();
  els.customDays.value = state.days;
  els.sourceSelect.value = state.source;
  setActiveDays();
  setActiveSource();
  await loadData();
}

function bindEvents() {
  document.addEventListener("click", async (e) => {
    const source = e.target.closest("[data-source]")?.dataset.source;
    if (source) {
      state.source = source;
      state.search = "";
      state.modelFilter = "all";
      persistUiState();
      renderModelOptions();
      setActiveSource();
      renderTabs();
      await loadData();
      return;
    }

    const days = e.target.closest("[data-days]")?.dataset.days;
    if (days) {
      state.days = Number(days);
      els.customDays.value = state.days;
      state.modelFilter = "all";
      persistUiState();
      renderModelOptions();
      setActiveDays();
      await loadData();
      return;
    }

    const tab = e.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      state.tab = tab;
      state.search = "";
      persistUiState();
      renderTabs();
      render();
      syncLivePolling();
      return;
    }

    if (e.target.closest("#refreshButton")) return loadData({ force: true });
    if (e.target.closest("#pathButton")) {
      state.tab = "Settings";
      state.search = "";
      renderTabs();
      render();
      syncLivePolling();
      return;
    }
    if (e.target.closest("#savePrices")) return savePrices();
    if (e.target.closest("#savePaths"))  return savePaths();
  });

  els.modelFilter.addEventListener("change", async () => {
    state.modelFilter = els.modelFilter.value;
    persistUiState();
    await loadData();
  });

  els.sourceSelect.addEventListener("change", async () => {
    const value = els.sourceSelect.value;
    state.source = ["minimax", "opencode", "opencode-go"].includes(value) ? value : "minimax";
    state.modelFilter = "all";
    persistUiState();
    renderModelOptions();
    await loadData();
  });

  els.customDays.addEventListener("change", async () => {
    state.days = clamp(Number(els.customDays.value), 1, 3650);
    els.customDays.value = state.days;
    state.modelFilter = "all";
    persistUiState();
    renderModelOptions();
    setActiveDays();
    await loadData();
  });

  document.addEventListener("input", (e) => {
    if (e.target.matches("#tableSearch")) {
      state.search = e.target.value;
      render();
      requestAnimationFrame(() => {
        const input = document.getElementById("tableSearch");
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      });
    }
    if (e.target.matches("#pricePresetSearch")) {
      filterPricePresetRows(e.target.value);
    }
  });

  document.addEventListener("visibilitychange", syncLivePolling);
}

// ---------------------------------------------------------------------------
// data loading

async function loadData(options = {}) {
  const force = Boolean(options.force);
  const requestId = ++state.loadRequestId;
  state.liveRequestId += 1;
  state.liveInflight = false;
  const params = new URLSearchParams({
    days: String(state.days),
    price: state.price,
    limit: "100"
  });
  if (state.source === "opencode") {
    params.set("source", "opencode-zen");
  } else if (state.source === "opencode-go") {
    params.set("source", "opencode-go");
    params.set("billing", "go");
  }
  applyModelFilter(params);
  const source = state.source;
  const apiSource = source === "opencode-go" || source === "opencode" ? "opencode" : source;
  const cacheKey = `${source}?${params.toString()}`;
  state.activeCacheKey = cacheKey;
  const cached = !force ? state.responseCache.get(cacheKey) || readCache(`summary:${cacheKey}`) : null;
  if (cached) {
    state.data = withCachedLive(clonePayload(cached), source);
    state.loading = false;
    if (state.modelFilter === "all") updateModelOptionsFromData();
    renderModelOptions();
    setActiveDays();
    updatePathLabel();
    render();
    syncLivePolling();
  } else {
    state.data = null;
    state.loading = true;
    render();
  }

  try {
    const requestParams = new URLSearchParams(params);
    if (force) requestParams.set("force", "1");
    const payload = await fetchJson(`/api/${apiSource}?${requestParams.toString()}`);
    if (requestId !== state.loadRequestId || source !== state.source || cacheKey !== state.activeCacheKey) return;
    state.responseCache.set(cacheKey, clonePayload(payload));
    writeCache(`summary:${cacheKey}`, payload);
    state.data = withCachedLive(payload, source);
  } catch (err) {
    if (requestId !== state.loadRequestId || source !== state.source) return;
    state.data = cached
      ? { ...state.data, errors: { ...(state.data?.errors || {}), load: err.message } }
      : { source, errors: { load: err.message } };
  } finally {
    if (requestId !== state.loadRequestId || source !== state.source) return;
    if (state.modelFilter === "all") updateModelOptionsFromData();
    renderModelOptions();
    state.loading = false;
    setActiveDays();
    updatePathLabel();
    render();
    syncLivePolling();
  }
}

function applyModelFilter(params) {
  if (state.modelFilter === "all") return;
  const opt = state.modelOptions.find((m) => m.value === state.modelFilter);
  if (!opt) return;
  params.set("provider", opt.provider);
  params.set("model", opt.model);
  params.set("variant", opt.variant);
}

// ---------------------------------------------------------------------------
// live polling

function syncLivePolling() {
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
  if (state.loading || !state.data || document.hidden) return;
  if (state.tab !== "Live") return;

  refreshLiveSnapshot();
  state.liveTimer = setInterval(refreshLiveSnapshot, 5000);
}

async function refreshLiveSnapshot() {
  if (state.liveInflight || !state.data) return;
  const source = state.source;
  const tab = state.tab;
  const requestId = ++state.liveRequestId;
  state.liveInflight = true;
  try {
    const params = new URLSearchParams({ price: state.price, days: String(state.days) });
    if (state.source === "opencode") {
      params.set("source", "opencode-zen");
    } else if (state.source === "opencode-go") {
      params.set("source", "opencode-go");
      params.set("billing", "go");
    }
    applyModelFilter(params);
    const apiSource = source === "opencode-go" || source === "opencode" ? "opencode" : source;
    const live = await fetchJson(`/api/${apiSource}/live?${params.toString()}`);
    if (requestId !== state.liveRequestId || source !== state.source || tab !== state.tab) return;
    state.liveCache.set(source, clonePayload(live));
    writeCache(`live:${source}`, live);
    state.data.live = live;
    if (state.data.errors?.live) {
      const { live: _liveError, ...remaining } = state.data.errors;
      state.data.errors = remaining;
    }
    render();
  } catch (err) {
    if (requestId !== state.liveRequestId || source !== state.source || tab !== state.tab) return;
    if (!state.data.errors) state.data.errors = {};
    state.data.errors.live = err.message;
    render();
  } finally {
    if (requestId === state.liveRequestId) state.liveInflight = false;
  }
}

// ---------------------------------------------------------------------------
// tabs

function renderTabs() {
  els.tabs.innerHTML = TABS.map((tab) => `
    <button class="tab ${state.tab === tab ? "active" : ""}" type="button" data-tab="${tab}">${tab}</button>
  `).join("");
}

function setActiveDays() {
  document.querySelectorAll("[data-days]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.days) === state.days);
  });
}

function setActiveSource() {
  if (els.sourceSelect) {
    els.sourceSelect.value = state.source;
  }
}

function sourceLabel() {
  if (state.source === "opencode-go") return "OpenCode Go";
  if (state.source === "opencode") return "OpenCode Zen";
  return "MiniMax App";
}

function isOpenCodeSource() {
  return state.source === "opencode" || state.source === "opencode-go";
}

function updatePathLabel() {
  const path = state.data?.paths?.dataSource || state.config?.sources?.[state.source]?.dataSource || "";
  els.pathButton.textContent = "DB path";
  els.pathButton.title = path || "(unknown)";
}

function render() {
  if (state.loading && !state.data) {
    els.content.innerHTML = `<section class="panel"><div class="empty">Loading ${sourceLabel()} data…</div></section>`;
    return;
  }
  if (!state.data) {
    els.content.innerHTML = `<section class="panel"><div class="empty">No data loaded.</div></section>`;
    return;
  }
  const renderer = {
    Overview: renderOverview,
    Live:     renderLive,
    Models:   renderModels,
    History:  renderHistory,
    Compare:  renderCompare,
    Sessions: renderSessions,
    Settings: renderSettings
  }[state.tab];

  els.content.innerHTML = `<section class="panel">${renderErrors()}${renderer()}</section>`;
}

// ---------------------------------------------------------------------------
// tab: overview

function renderOverview() {
  const total = state.data.events?.total?.usage || {};
  const totalAggregate = state.data.events?.total || {};
  const models = state.data.events?.models || [];
  const periods = state.data.history?.day_periods || [];

  return `
    <div class="grid cards">
      ${metric("Total tokens", fmtNum(total.total), `${fmtNum(totalAggregate.sessions || 0)} sessions / ${fmtNum(totalAggregate.events || 0)} events`)}
      ${metric("Input / cache read", `${fmtNum(total.input)} / ${fmtNum(total.cacheRead)}`, `${fmtNum(total.cacheWrite)} cache write`)}
      ${metric("Output", fmtNum(total.output), `${fmtNum(total.reasoning)} reasoning`)}
      ${metric("Estimate", fmtMoney(state.data.events?.total?.normal_estimated_usd), estimateNote(), { gradient: true })}
    </div>
    ${renderGoPromotionNotice()}
    <div class="grid two" style="margin-top:14px">
      <div class="section">
        <div class="section-head"><h2>Token mix</h2><span class="pill">${state.days} days</span></div>
        ${renderTokenStack(total)}
        ${renderLegend()}
      </div>
      <div class="section">
        <div class="section-head"><h2>Model share</h2><span class="pill">${models.length} rows</span></div>
        ${renderModelShare(models)}
      </div>
      <div class="section">
        <div class="section-head"><h2>Daily tokens</h2><span class="pill">${periods.length} periods</span></div>
        ${renderBars(periods)}
      </div>
      <div class="section">
        <div class="section-head"><h2>Source boundary</h2><span class="pill">${state.source}</span></div>
        ${renderFormulaBlock()}
      </div>
    </div>
  `;
}

function estimateNote() {
  const total = state.data.events?.total;
  if (total?.estimate_complete === false) {
    const count = total.estimate_missing_models?.length || 0;
    return `partial: ${count} missing price`;
  }
  return `preset: ${state.price}`;
}

function renderGoPromotionNotice() {
  if (state.source !== "opencode-go") return "";
  const summary = state.data.events?.total?.promotion_summary;
  if (!summary?.events) return "";
  return `
    <div class="section promotion-note" style="margin-top:14px">
      <div class="section-head">
        <h2>Historical MiniMax M3 promotion</h2>
        <span class="pill promotion-pill">3\u00d7 GO promotion</span>
      </div>
      <div class="promotion-cost-summary">
        <div><span>Promotion usage</span><strong>${fmtNum(summary.usage_total)} tokens</strong></div>
        <div><span>Events / sessions</span><strong>${fmtNum(summary.events)} / ${fmtNum(summary.sessions)}</strong></div>
        <div><span>Stored OpenCode cost</span><strong>${fmtMoney(summary.stored_cost_usd)}</strong></div>
        <div><span>Calculated normal price</span><strong>${fmtMoney(summary.normal_cost_usd)}</strong></div>
      </div>
      <div class="subtle promotion-disclaimer">Detected from the historical local OpenCode cost signature. This is not a confirmed server-side GO quota deduction. Raw tokens remain unchanged.</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// tab: live

function renderLive() {
  const live = state.data.live || {};
  const session = live.session;
  const event   = live.latestEvent;
  if (!session && !event) {
    return `<div class="empty">No ${sourceLabel()} live data found.</div>`;
  }
  return `
    <div class="grid cards">
      ${metric("Latest event", event?.model_display || "-", event?.promotion?.label || fmtDateMs(event?.timeCreated))}
      ${metric("Event tokens", fmtNum(event?.usage?.total), event ? `${fmtNum(event.usage.cacheRead)} cache read` : "")}
      ${metric("Session total", fmtNum(session?.usage?.total), session?.title || session?.id || "-")}
      ${metric("Estimate", fmtMoney(event?.normal_estimated_usd ?? session?.normal_estimated_usd), liveNote(event, session))}
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="section">
        <div class="section-head"><h2>Latest token event</h2><span class="pill">token_usage</span></div>
        ${event ? renderUsageCards(event.usage) : `<div class="empty">No matching token event found.</div>`}
        ${event ? renderLiveMeta(event) : ""}
        ${event ? renderPromotionCost(event) : ""}
      </div>
      <div class="section">
        <div class="section-head"><h2>Latest session</h2><span class="pill">session aggregate</span></div>
        ${session ? renderUsageCards(session.usage) : `<div class="empty">No session aggregate found.</div>`}
        ${session ? renderLiveMeta(session) : ""}
      </div>
    </div>
  `;
}

function liveNote(event, session) {
  const row = event || session;
  if (!row) return "-";
  if (row.estimate_missing_price) return `missing price: ${row.normal_price_preset || row.model?.id || "-"}`;
  return row.normal_price_preset || "-";
}

function renderPromotionCost(row) {
  const summary = row?.promotion_summary;
  const promotion = row?.promotion;
  const storedCost = summary?.stored_cost_usd ?? promotion?.stored_cost_usd;
  const normalCost = summary?.normal_cost_usd ?? promotion?.normal_cost_usd;
  if (!promotion && !summary?.events) return "";
  return `
    <div class="promotion-inline">
      <div><span>Stored OpenCode cost</span><strong>${fmtMoney(storedCost)}</strong></div>
      <div><span>Normal price</span><strong>${fmtMoney(normalCost)}</strong></div>
      <p>Local OpenCode cost signature, not a confirmed GO quota deduction.</p>
    </div>
  `;
}

function renderUsageCards(usage) {
  if (!usage) return `<div class="empty">No usage available.</div>`;
  return `
    <div class="grid cards usage-cards">
      ${metric("Input",       fmtNum(usage.input),      "")}
      ${metric("Cache read",  fmtNum(usage.cacheRead),  "")}
      ${metric("Output",      fmtNum(usage.output),     "")}
      ${metric("Reasoning",   fmtNum(usage.reasoning),  `${fmtNum(usage.cacheWrite)} cache write`)}
    </div>
  `;
}

function renderLiveMeta(row) {
  return `
    <div class="live-meta">
      <div><span>Model</span><strong>${escapeHtml(row.model_display || "-")}</strong></div>
      <div><span>Updated</span><strong>${fmtDateMs(row.timeUpdated || row.timeCreated)}</strong></div>
      <div><span>Source</span><strong class="mono">${escapeHtml(row.sessionId || row.id || "-")}</strong></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// tab: models

function renderModels() {
  const rows = filterRows(state.data.events?.models || [], (r) => r.model_display);
  return `
    ${tableToolbar("Models", rows.length)}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Provider / model / variant</th>
          <th class="num">Sessions</th>
          <th class="num">Events</th>
          <th>Last used</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Reasoning</th>
          <th class="num">Cache read</th>
          <th class="num">Cache write</th>
          <th class="num">Total</th>
          <th class="num">Estimate</th>
          <th>Price</th>
        </tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="mono">${modelNameWithBadge(row)}</td>
            <td class="num">${fmtNum(row.sessions)}</td>
            <td class="num">${fmtNum(row.events)}</td>
            <td>${fmtDateMs(row.lastUsed)}</td>
            <td class="num">${fmtNum(row.usage.input)}</td>
            <td class="num">${fmtNum(row.usage.output)}</td>
            <td class="num">${fmtNum(row.usage.reasoning)}</td>
            <td class="num">${fmtNum(row.usage.cacheRead)}</td>
            <td class="num">${fmtNum(row.usage.cacheWrite)}</td>
            <td class="num">${fmtNum(row.usage.total)}</td>
            <td class="num">${promotionEstimateCell(row)}</td>
            <td class="mono">${modelPriceLabel(row)}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// tab: history

function renderHistory() {
  const history = state.data.history || { week_periods: [], day_periods: [] };
  return `
    <div class="grid">
      <div class="section">
        <div class="section-head"><h2>Weeks</h2><span class="pill">${history.week_periods.length}</span></div>
        ${renderPeriodCards(history.week_periods)}
      </div>
      <div class="section">
        <div class="section-head"><h2>Days</h2><span class="pill">${history.day_periods.length}</span></div>
        ${renderPeriodCards(history.day_periods)}
      </div>
    </div>
  `;
}

function renderPeriodCards(periods) {
  if (!periods?.length) return `<div class="empty">No periods in range.</div>`;
  return `<div class="period">${periods.map((row) => `
    <article class="period-card">
      <div class="period-main">
        <strong>${escapeHtml(row.period)}</strong>
        ${kv("Sessions", fmtNum(row.sessions))}
        ${kv("Events", fmtNum(row.events))}
        ${kv("Input", fmtNum(row.usage.input))}
        ${kv("Cache read", fmtNum(row.usage.cacheRead))}
        ${kv("Total", fmtNum(row.usage.total))}
        ${kv("Last used", fmtDateMs(row.lastUsed))}
      </div>
      ${renderNestedModels(row.models || [])}
    </article>
  `).join("")}</div>`;
}

function renderNestedModels(models) {
  if (!models?.length) return "";
  const rows = models.slice(0, 8).map((row) => `
    <div class="nested-row">
      <strong>${modelNameWithBadge(row)}</strong>
      <span>${fmtNum(row.usage.total)} total</span>
      <span>${fmtNum(row.usage.cacheRead)} cache</span>
      <span class="hide-small">${fmtNum(row.events)} ev</span>
      <span class="hide-small">${fmtNum(row.sessions)} sess</span>
    </div>
  `).join("");
  return `<div class="nested-models">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// tab: compare

function renderCompare() {
  const compare = state.data.compare || {};
  const rows = compare.models || [];
  return `
    <div class="grid cards">
      ${metric("Source total", fmtNum(compare.source_total?.usage?.total), `${sourceLabel()} only`)}
      ${metric("Formula", sourceLabel(), compare.formula || "")}
      ${metric("Rows", fmtNum(rows.length), "enabled in Settings")}
      ${metric("Highest", fmtMoney(rows[0]?.estimated_usd), rows[0]?.model || "-")}
    </div>
    <div class="table-wrap" style="margin-top:14px">
      <table>
        <thead><tr>
          <th>Model</th>
          <th class="num">Input / M</th>
          <th class="num">Cached / M</th>
          <th class="num">Cache write / M</th>
          <th class="num">Output / M</th>
          <th class="num">Estimate</th>
          <th>Note</th>
        </tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="mono">${escapeHtml(row.model)}</td>
            <td class="num">${fmtPrice(row.prices_usd_per_million.input)}</td>
            <td class="num">${fmtPrice(row.prices_usd_per_million.cached)}</td>
            <td class="num">${fmtPrice(row.prices_usd_per_million.cacheWrite ?? row.prices_usd_per_million.input)}</td>
            <td class="num">${fmtPrice(row.prices_usd_per_million.output)}</td>
            <td class="num">${fmtMoney(row.estimated_usd)}</td>
            <td>${escapeHtml(row.note || row.full_note || "")}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// tab: sessions

function renderSessions() {
  const rows = filterRows(state.data.sessions?.sessions || [], (r) => `${r.model_display} ${r.title} ${r.directory} ${r.id}`);
  return `
    ${tableToolbar("Sessions", rows.length)}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Updated</th>
          <th>Provider / model / variant</th>
          <th>Title</th>
          <th class="num">Input</th>
          <th class="num">Cache read</th>
          <th class="num">Cache write</th>
          <th class="num">Output</th>
          <th class="num">Reasoning</th>
          <th class="num">Total</th>
          <th class="num">Estimate</th>
          <th>Session</th>
        </tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td>${fmtDateMs(row.timeUpdated)}</td>
            <td class="mono">${modelNameWithBadge(row)}</td>
            <td class="path-cell">${escapeHtml(row.title || row.directory || "")}</td>
            <td class="num">${fmtNum(row.usage.input)}</td>
            <td class="num">${fmtNum(row.usage.cacheRead)}</td>
            <td class="num">${fmtNum(row.usage.cacheWrite)}</td>
            <td class="num">${fmtNum(row.usage.output)}</td>
            <td class="num">${fmtNum(row.usage.reasoning)}</td>
            <td class="num">${fmtNum(row.usage.total)}</td>
            <td class="num">${fmtMoney(row.normal_estimated_usd)}</td>
            <td class="mono path-cell">${escapeHtml(row.id)}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// tab: settings

function renderSettings() {
  return `
    <div class="settings-grid">
      <div class="section">
        <div class="section-head"><h2>Paths</h2><button id="savePaths" class="command" type="button">Save</button></div>
        <div class="grid">
          <label class="field path-field">
            <span>MiniMax DB</span>
            <input id="minimaxDbPath" type="text" value="${escapeHtml(state.config.settings?.minimaxDbPath || state.config.sources?.minimax?.dataSource)}">
          </label>
          <label class="field path-field">
            <span>OpenCode DB</span>
            <input id="opencodeDbPath" type="text" value="${escapeHtml(state.config.settings?.opencodeDbPath || state.config.sources?.opencode?.dataSource)}">
          </label>
          ${pathMetric("Settings file", state.config.settingsPath || "-")}
          ${pathMetric("Prices file", state.config.priceBookPath)}
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Data diagnostics</h2>${qualityPill(state.data?.quality)}</div>
        ${renderQualityDiagnostics()}
      </div>
      <div class="section price-presets-section">
        <div class="section-head"><h2>Price presets</h2><button id="savePrices" class="command" type="button">Save</button></div>
        <div class="preset-tools">
          <label class="field preset-search">
            <span>Search</span>
            <input id="pricePresetSearch" type="search" placeholder="Filter models">
          </label>
          <div class="preset-count">
            <strong>${fmtNum((state.config.priceBook.comparePresets || []).length)}</strong>
            <span>in Compare</span>
          </div>
        </div>
        <div class="preset-groups">
          ${renderPricePresetGroups()}
        </div>
      </div>
    </div>
  `;
}

function renderQualityDiagnostics() {
  const quality = state.data?.quality;
  if (!quality) return `<div class="empty">No diagnostics available.</div>`;
  const summaryRows = Object.entries(quality.summary || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== 0 && typeof v !== "object")
    .map(([k, v]) => `<tr><td class="mono">${escapeHtml(k)}</td><td class="num">${fmtNum(v)}</td></tr>`)
    .join("");
  const issueRows = (quality.issues || []).map((issue) => `
    <tr class="diagnostic-row diagnostic-${escapeHtml(issue.severity || "info")}">
      <td><span class="pill quality-${escapeHtml(issue.severity || "info")}">${escapeHtml(issue.severity || "info")}</span></td>
      <td class="mono">${escapeHtml(issue.code || "-")}</td>
      <td>${escapeHtml(issue.message || "")}</td>
      <td class="num">${fmtNum(issue.tokens ?? issue.count ?? "")}</td>
    </tr>
  `).join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Summary</th><th class="num">Value</th></tr></thead>
        <tbody>${summaryRows || `<tr><td colspan="2">No diagnostic counters.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="table-wrap" style="margin-top:14px">
      <table>
        <thead><tr><th>Level</th><th>Code</th><th>Message</th><th class="num">Tokens / count</th></tr></thead>
        <tbody>${issueRows || `<tr><td colspan="4">No issues.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function qualityPill(quality) {
  if (!quality) return `<span class="pill">unknown</span>`;
  return `<span class="pill quality-${escapeHtml(quality.status)}">${escapeHtml(quality.status)}</span>`;
}

function renderPricePresetGroups() {
  const entries = Object.entries(state.config.priceBook.presets || {})
    .sort(([a], [b]) => pricePresetSortKey(a).localeCompare(pricePresetSortKey(b), "en", {
      numeric: true,
      sensitivity: "base"
    }) || a.localeCompare(b, "en", { sensitivity: "base" }));
  if (!entries.length) return `<div class="empty">No presets defined.</div>`;
  const groups = [
    ["OpenCode Zen", ([name]) => name.startsWith("opencode-zen/")],
    ["OpenCode Go", ([name]) => name.startsWith("opencode-go/")],
    ["OpenRouter", ([name]) => !name.startsWith("opencode-go/") && !name.startsWith("opencode-zen/")]
  ].map(([title, predicate]) => ({ title, rows: entries.filter(predicate) }))
    .filter((group) => group.rows.length);
  return groups.map((group) => `
    <div class="preset-group" data-preset-group="${escapeHtml(group.title.toLowerCase())}">
      <div class="preset-group-head"><h3>${escapeHtml(group.title)}</h3><span class="pill">${fmtNum(group.rows.length)} models</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Compare</th>
            <th>Model</th>
            <th class="num">Input</th>
            <th class="num">Cached</th>
            <th class="num">Cache write</th>
            <th class="num">Output</th>
            <th>Note</th>
          </tr></thead>
          <tbody>${group.rows.map(([name, price]) => renderPricePresetRow(name, price)).join("")}</tbody>
        </table>
      </div>
    </div>
  `).join("");
}

function renderPricePresetRow(name, price) {
  const searchText = `${name} ${name.replace(/[\/_-]+/g, " ")} ${state.config.priceBook.notes[name] || ""}`.toLowerCase();
  return `
    <tr data-price-row="${escapeHtml(name)}" data-price-search="${escapeHtml(searchText)}">
      <td><label class="compare-toggle"><input type="checkbox" data-compare-preset="${escapeHtml(name)}" ${isComparePreset(name) ? "checked" : ""}><span></span></label></td>
      <td class="mono">${escapeHtml(name)}</td>
      <td class="num"><input class="price-input" data-price-name="${escapeHtml(name)}" data-price-field="input" type="number" min="0" step="0.000001" value="${price.input}"></td>
      <td class="num"><input class="price-input" data-price-name="${escapeHtml(name)}" data-price-field="cached" type="number" min="0" step="0.000001" value="${price.cached}"></td>
      <td class="num"><input class="price-input" data-price-name="${escapeHtml(name)}" data-price-field="cacheWrite" type="number" min="0" step="0.000001" placeholder="input" value="${price.cacheWrite ?? ""}"></td>
      <td class="num"><input class="price-input" data-price-name="${escapeHtml(name)}" data-price-field="output" type="number" min="0" step="0.000001" value="${price.output}"></td>
      <td>${escapeHtml(state.config.priceBook.notes[name] || "")}</td>
    </tr>
  `;
}

function pricePresetSortKey(name) {
  return String(name)
    .replace(/^opencode-(?:go|zen)\//, "")
    .replace(/^xai-/, "");
}

function filterPricePresetRows(query) {
  const text = String(query || "").trim().toLowerCase();
  for (const row of document.querySelectorAll("[data-price-row]")) {
    row.hidden = text ? !row.dataset.priceSearch.includes(text) : false;
  }
}

async function savePrices() {
  const next = structuredClone(state.config.priceBook);
  next.comparePresets = [...document.querySelectorAll("[data-compare-preset]:checked")]
    .map((input) => input.dataset.comparePreset)
    .filter((name) => next.presets[name]);
  for (const input of document.querySelectorAll("[data-price-name]")) {
    const name = input.dataset.priceName;
    const field = input.dataset.priceField;
    if (field === "cacheWrite" && input.value === "") {
      delete next.presets[name][field];
    } else {
      next.presets[name][field] = Number(input.value);
    }
  }
  const result = await fetchJson("/api/settings/prices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priceBook: next })
  });
  state.config.priceBook = result.priceBook;
  clearCaches();
  renderModelOptions();
  await loadData({ force: true });
}

async function savePaths() {
  const settings = {
    minimaxDbPath: document.getElementById("minimaxDbPath")?.value || state.config.settings?.minimaxDbPath,
    opencodeDbPath: document.getElementById("opencodeDbPath")?.value || state.config.settings?.opencodeDbPath
  };
  const result = await fetchJson("/api/settings/paths", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings })
  });
  state.config.settings = result.settings;
  if (state.config.sources) {
    if (state.config.sources.minimax) state.config.sources.minimax.dataSource = result.settings.minimaxDbPath;
    if (state.config.sources.opencode) state.config.sources.opencode.dataSource = result.settings.opencodeDbPath;
    if (state.config.sources["opencode-go"]) state.config.sources["opencode-go"].dataSource = result.settings.opencodeDbPath;
  }
  clearCaches();
  state.modelFilter = "all";
  renderModelOptions();
  await loadData({ force: true });
}

function isComparePreset(name) {
  return (state.config.priceBook.comparePresets || []).includes(name);
}

// ---------------------------------------------------------------------------
// shared components

function renderFormulaBlock() {
  const formulas = state.data.formulas || {};
  return `
    <div class="grid">
      ${pathMetric("Token total", formulas.total || "-")}
      ${pathMetric("Estimate", formulas.estimate || "-")}
      ${pathMetric("Source time", formulas.sourceTime || "-")}
    </div>
  `;
}

function renderTokenStack(usage) {
  return `<div class="stack" aria-label="Token mix">${renderTokenSegments(usage, true)}</div>`;
}

function renderLegend() {
  const parts = [
    ["part-input",       "input"],
    ["part-cache",       "cache read"],
    ["part-cache-write", "cache write"],
    ["part-output",      "output"],
    ["part-reasoning",   "reasoning"]
  ];
  return `<div class="legend">${parts.map(([c, l]) => `<span><i class="${c}"></i>${l}</span>`).join("")}</div>`;
}

function renderBars(periods) {
  if (!periods?.length) return `<div class="empty">No day data in range.</div>`;
  const rows = periods;
  const max = Math.max(...rows.map((r) => r.usage?.total || 0), 1);
  return `<div class="bars daily-bars">${rows.map((row) => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(row.period)}</div>
      ${renderUsageBar(row.usage, row.usage?.total || 0, max)}
      <div class="bar-value">${fmtNum(row.usage?.total || 0)}</div>
    </div>
  `).join("")}</div>`;
}

function renderModelShare(models) {
  if (!models.length) return `<div class="empty">No models in range.</div>`;
  const top = models.slice(0, 8);
  const max = Math.max(...top.map((row) => row.usage?.total || 0), 1);
  return `<div class="model-share">${top.map((row) => `
    <div>
      <div class="share-row">
        <strong class="mono">${modelNameWithBadge(row)}</strong>
        <span>${fmtNum(row.usage?.total || 0)}</span>
      </div>
      ${renderUsageBar(row.usage, row.usage?.total || 0, max)}
    </div>
  `).join("")}</div>`;
}

function modelNameWithBadge(row) {
  const name = escapeHtml(row?.model_display || "-");
  return row?.promotion?.id === "minimax-m3-go-3x"
    ? `${name}<span class="pill promotion-pill">3\u00d7 GO</span>`
    : name;
}

function modelPriceLabel(row) {
  if (row?.promotion?.id === "minimax-m3-go-3x") {
    return `local ${fmtMoney(row.promotion_summary?.stored_cost_usd)} / normal ${fmtMoney(row.promotion_summary?.normal_cost_usd)}`;
  }
  return escapeHtml(row?.normal_price_preset || (row?.estimate_missing_price ? "missing" : "-"));
}

function promotionEstimateCell(row) {
  if (row?.promotion?.id !== "minimax-m3-go-3x") return fmtMoney(row?.normal_estimated_usd);
  return `<strong>${fmtMoney(row.normal_estimated_usd)}</strong><div class="subtle estimate-detail">OpenCode local: ${fmtMoney(row.promotion_summary?.stored_cost_usd)}</div>`;
}

function renderUsageBar(usage, value, max) {
  const width = value > 0 ? Math.max(value / max * 100, 1) : 0;
  return `
    <div class="bar-track">
      <div class="bar-fill segmented-fill" style="width:${width}%">${renderTokenSegments(usage, false)}</div>
    </div>
  `;
}

function renderTokenSegments(usage, keepTinyVisible) {
  const parts = tokenParts(usage).filter((p) => p.value > 0);
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (!total) return "";
  return parts.map((p) => {
    const w = p.value / total * 100;
    const visibleWidth = keepTinyVisible ? Math.max(w, 1) : w;
    return `<span class="${p.className}" style="width:${visibleWidth}%"></span>`;
  }).join("");
}

function tokenParts(usage) {
  if (!usage) return [];
  return [
    { className: "part-input",       value: usage.input || 0 },
    { className: "part-cache",       value: usage.cacheRead || 0 },
    { className: "part-cache-write", value: usage.cacheWrite || 0 },
    { className: "part-output",      value: usage.output || 0 },
    { className: "part-reasoning",   value: usage.reasoning || 0 }
  ];
}

function tableToolbar(title, count) {
  return `
    <div class="toolbar">
      <div>
        <h2>${title}</h2>
        <div class="subtle">${fmtNum(count)} rows</div>
      </div>
      <label class="field">
        <span>Search</span>
        <input id="tableSearch" type="search" value="${escapeHtml(state.search)}">
      </label>
    </div>
  `;
}

function metric(label, value, note, options = {}) {
  return `
    <div class="metric">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value${options.gradient ? " gradient" : ""}">${escapeHtml(value)}</div>
      <div class="note">${escapeHtml(note || "")}</div>
    </div>
  `;
}

function pathMetric(label, value) {
  return `
    <div class="metric">
      <div class="label">${escapeHtml(label)}</div>
      <div class="note path-cell">${escapeHtml(value || "-")}</div>
    </div>
  `;
}

function kv(label, value) {
  return `<div class="kv">${escapeHtml(label)}<b>${escapeHtml(value)}</b></div>`;
}

function renderErrors() {
  const errors = Object.entries(state.data?.errors || {});
  if (!errors.length) return "";
  return `<div class="error-box" style="margin-bottom:14px">${errors.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join("<br>")}</div>`;
}

// ---------------------------------------------------------------------------
// model filter

function renderModelOptions() {
  const options = state.modelOptions || [];
  const rows = [
    `<option value="all">All used models</option>`,
    ...options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
  ];
  els.modelFilter.innerHTML = rows.join("");
  els.modelFilter.value = options.some((o) => o.value === state.modelFilter) ? state.modelFilter : "all";
}

function updateModelOptionsFromData() {
  // For OpenCode sources, only show MiniMax-prefixed model ids (the user wants
  // the source switcher to scope to MiniMax models, not expose the whole
  // OpenCode catalog like MiMo/Qwen/GLM).
  const sourceModels = state.data.events?.models || [];
  const filtered = isOpenCodeSource()
    ? sourceModels.filter((row) => isMinimaxModelId(row.model?.id))
    : sourceModels;
  state.modelOptions = filtered.map((row) => ({
    value:    row.model_display,
    label:    `${row.model_display} — ${fmtNum(row.usage.total)} tokens`,
    provider: row.model?.providerID || "unknown",
    model:    row.model?.id || "unknown",
    variant:  row.model?.variant || "default"
  }));
}

function isMinimaxModelId(id) {
  const text = String(id || "").toLowerCase();
  return text.startsWith("minimax-") || text === "minimax-m3" || text === "minimax-m2.7";
}

function filterRows(rows, textFn) {
  const query = state.search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => String(textFn(row)).toLowerCase().includes(query));
}

function withCachedLive(payload, source) {
  const data = clonePayload(payload);
  const live = state.liveCache.get(source) || readCache(`live:${source}`);
  if (live) {
    state.liveCache.set(source, clonePayload(live));
    data.live = clonePayload(live);
  }
  return data;
}

function restoreUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || "null");
    if (!saved || typeof saved !== "object") return;
    if (["minimax", "opencode", "opencode-go"].includes(saved.source)) state.source = saved.source;
    if (TABS.includes(saved.tab)) state.tab = saved.tab;
    if (Number.isInteger(Number(saved.days))) state.days = clamp(Number(saved.days), 1, 3650);
    if (typeof saved.modelFilter === "string" && saved.modelFilter) state.modelFilter = saved.modelFilter;
  } catch {
    // Invalid browser state falls back to stable defaults.
  }
}

function persistUiState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      source: state.source,
      tab: state.tab,
      days: state.days,
      modelFilter: state.modelFilter
    }));
  } catch {
    // UI state persistence is optional.
  }
}

function readCache(key) {
  try {
    const record = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${key}`) || "null");
    return record?.payload || null;
  } catch {
    return null;
  }
}

function writeCache(key, payload) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ savedAt: Date.now(), payload }));
  } catch {
    // Quota failures must not break fresh data loading.
  }
}

function clearCaches() {
  state.responseCache.clear();
  state.liveCache.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // The in-memory cache has already been cleared.
  }
}

function clonePayload(payload) {
  return typeof structuredClone === "function"
    ? structuredClone(payload)
    : JSON.parse(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// network & formatting

async function fetchJson(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const retries = method === "GET" ? 2 : 0;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error.name === "AbortError" ? new Error(`Request timed out: ${url}`) : error;
      if (attempt >= retries || !/failed to fetch|timed out|network/i.test(lastError.message)) break;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function fmtNum(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return Math.round(number).toLocaleString("de-DE");
}

function fmtMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `$${Number(value).toFixed(4)}`;
}

function fmtPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `$${Number(value).toString()}`;
}

function fmtDateMs(value) {
  const date = new Date(Number(value) || 0);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "-";
  return date.toLocaleString("de-DE");
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
