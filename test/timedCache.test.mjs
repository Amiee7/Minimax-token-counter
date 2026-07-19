import assert from "node:assert/strict";
import test from "node:test";

import { createTimedCache } from "../src/timedCache.mjs";

test("timed cache reuses values and coalesces concurrent loads", async () => {
  const cache = createTimedCache({ ttlMs: 1000 });
  let calls = 0;
  const loader = async () => ({ value: ++calls });
  const [first, second] = await Promise.all([
    cache.get("same", loader),
    cache.get("same", loader)
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(await cache.get("same", loader), first);
});

test("timed cache force reloads and clear removes entries", async () => {
  const cache = createTimedCache({ ttlMs: 10_000 });
  let calls = 0;
  const loader = async () => ++calls;
  assert.equal(await cache.get("key", loader), 1);
  assert.equal(await cache.get("key", loader, { force: true }), 2);
  cache.clear();
  assert.equal(await cache.get("key", loader), 3);
});
