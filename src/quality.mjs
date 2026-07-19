export function createQuality(source) {
  return {
    source,
    status: "ok",
    summary: {
      warnings: 0,
      errors: 0
    },
    issues: []
  };
}

export function addSummary(quality, key, amount = 1) {
  quality.summary[key] = (Number(quality.summary[key]) || 0) + amount;
}

export function addIssue(quality, severity, code, message, details = {}) {
  const issue = {
    severity,
    code,
    message,
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== null))
  };
  quality.issues.push(issue);
  if (severity === "error") {
    quality.summary.errors += 1;
  } else if (severity === "warning") {
    quality.summary.warnings += 1;
  }
  if (quality.summary.errors > 0) {
    quality.status = "error";
  } else if (quality.summary.warnings > 0) {
    quality.status = "warning";
  }
  return issue;
}

export function finalizeQuality(quality) {
  quality.summary.issue_count = quality.issues.length;
  if (quality.summary.errors > 0) {
    quality.status = "error";
  } else if (quality.summary.warnings > 0) {
    quality.status = "warning";
  } else {
    quality.status = "ok";
  }
  return quality;
}

export function addMissingPriceIssue(quality, rows, tokenField = "total") {
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

export function addInvalidTimeIssue(quality, rows, label = "event") {
  const count = (rows || []).filter((row) => !Number.isFinite(Number(row.timeCreated || row.timeUpdated)) || Number(row.timeCreated || row.timeUpdated) <= 0).length;
  if (!count) return;
  addSummary(quality, "invalid_time_rows", count);
  addIssue(quality, "warning", "invalid-time", `${count} ${label} row(s) have invalid timestamps.`, { count });
}

export function addUnknownModelIssue(quality, rows) {
  const unknown = (rows || []).filter((row) => {
    const model = row.model || {};
    return !model.id || model.id === "unknown" || !model.providerID || model.providerID === "unknown";
  });
  if (!unknown.length) return;
  addSummary(quality, "unknown_model_rows", unknown.length);
  addIssue(quality, "warning", "unknown-model", `${unknown.length} row(s) use an unknown model identity.`, { count: unknown.length });
}

export function cleanFilterValue(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "all") return null;
  return text;
}
