// test/quality.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addSummary,
  addIssue,
  createQuality,
  finalizeQuality
} from "../src/quality.mjs";

test("createQuality starts at status=ok", () => {
  const q = createQuality("minimax");
  assert.equal(q.source, "minimax");
  assert.equal(q.status, "ok");
  assert.equal(q.summary.warnings, 0);
  assert.equal(q.summary.errors, 0);
  assert.deepEqual(q.issues, []);
});

test("addSummary accumulates counters", () => {
  const q = createQuality("minimax");
  addSummary(q, "events", 3);
  addSummary(q, "events", 2);
  addSummary(q, "models");
  assert.equal(q.summary.events, 5);
  assert.equal(q.summary.models, 1);
});

test("addIssue escalates status when severity is warning or error", () => {
  const q = createQuality("minimax");
  addIssue(q, "warning", "missing-price", "1 model missing");
  assert.equal(q.status, "warning");
  assert.equal(q.summary.warnings, 1);
  addIssue(q, "error", "db-fail", "DB missing");
  assert.equal(q.status, "error");
  assert.equal(q.summary.errors, 1);
});

test("finalizeQuality locks in the final status", () => {
  const q = createQuality("minimax");
  addIssue(q, "info", "note", "FYI");
  finalizeQuality(q);
  assert.equal(q.status, "ok");
  assert.equal(q.summary.issue_count, 1);
});