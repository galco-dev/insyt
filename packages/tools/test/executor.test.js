const assert = require('node:assert');
const { test } = require('node:test');
const { applyChangeset, idempotencyKey } = require('../src/executor');

const mkStore = () => {
  const keys = new Set(); const ledger = []; const audit = [];
  return {
    hasKey: (k) => keys.has(k), saveKey: (k) => keys.add(k),
    ledger: (e) => ledger.push(e), audit: (e) => audit.push(e),
    _keys: keys, _ledger: ledger, _audit: audit,
  };
};

const okApi = () => new Proxy({}, { get: () => async () => ({ before: { x: 1 }, after: { x: 2 } }) });

const baseCtx = {
  account: { daily_budget_total_usd: 100, weekly_budget_delta_pct: 0, platform_min_daily_usd: 1 },
  campaign: () => ({ budget_daily_usd: 30, conversions_30d: 50, bidding: { target: 20 } }),
  convertingTerms: new Set(), pausedByUs: new Set(), primaryActionCount: 2, keyEventCount: 0,
  linkedAdsCustomerIds: [], approvals: [], gates: {},
};

const pause = (id, cid) => ({ id, tool_id: 'ads.pause_campaign', params: { campaign_id: cid }, summary_text: 'Paused a campaign', money_impact_usd: 50 });

test('applies approved changes, writes ledger + audit with before/after, saves idempotency keys', async () => {
  const store = mkStore();
  const { results, aborted, entities_touched } = await applyChangeset({
    changes: [pause('ch1', 'c1')], ctx: baseCtx, api: okApi(), store,
    tenantId: 'tn', runId: 'r1', changesetId: 'cs1',
  });
  assert.strictEqual(aborted, false);
  assert.strictEqual(entities_touched, 1);
  assert.strictEqual(results[0].status, 'applied');
  assert.deepStrictEqual(results[0].after, { x: 2 });
  assert.strictEqual(store._ledger.length, 1);
  assert.strictEqual(store._ledger[0].event, 'fix_applied');
  assert.ok(store._keys.has(idempotencyKey({ tenantId: 'tn', runId: 'r1', toolId: 'ads.pause_campaign', target: 'c1' })));
});

test('async store (production PostgREST): a fresh change is APPLIED, not mistaken for a replay', async () => {
  // Regression: 31 Aug 2026 - `if (store.hasKey(key))` on an async store saw a
  // Promise (always truthy) and skipped every approved change in production.
  const sync = mkStore();
  const store = {
    ...sync,
    hasKey: async (k) => sync._keys.has(k), saveKey: async (k) => { sync._keys.add(k); },
    ledger: async (e) => { sync._ledger.push(e); }, audit: async (e) => { sync._audit.push(e); },
  };
  const { results } = await applyChangeset({
    changes: [pause('ch1', 'c1')], ctx: baseCtx, api: okApi(), store, tenantId: 'tn', runId: 'r1', changesetId: 'cs1',
  });
  assert.strictEqual(results[0].status, 'applied');
  assert.strictEqual(sync._ledger.length, 1, 'ledger row written (awaited)');
  // And a genuine replay through the async store is still skipped.
  const again = await applyChangeset({
    changes: [pause('ch2', 'c1')], ctx: baseCtx, api: okApi(), store, tenantId: 'tn', runId: 'r1', changesetId: 'cs2',
  });
  assert.strictEqual(again.results[0].status, 'skipped');
});

test('idempotent replay: an already-applied change is skipped, no double ledger', async () => {
  const store = mkStore();
  store.saveKey(idempotencyKey({ tenantId: 'tn', runId: 'r1', toolId: 'ads.pause_campaign', target: 'c1' }));
  const { results } = await applyChangeset({
    changes: [pause('ch1', 'c1')], ctx: baseCtx, api: okApi(), store, tenantId: 'tn', runId: 'r1', changesetId: 'cs1',
  });
  assert.strictEqual(results[0].status, 'skipped');
  assert.strictEqual(store._ledger.length, 0);
});

test('guardrail block: no API call, audit row explains, ledger untouched', async () => {
  const store = mkStore();
  let apiCalled = false;
  const api = new Proxy({}, { get: () => async () => { apiCalled = true; return { before: {}, after: {} }; } });
  const { results } = await applyChangeset({
    changes: [{ id: 'ch1', tool_id: 'ga4.set_retention', params: { property_id: 'p', months: 2 } }],
    ctx: baseCtx, api, store, tenantId: 'tn', runId: 'r1', changesetId: 'cs1',
  });
  assert.strictEqual(results[0].status, 'failed');
  assert.match(results[0].reason, /14 months/);
  assert.strictEqual(apiCalled, false);
  assert.strictEqual(store._audit[0].event, 'change_guardrail_blocked');
});

test('entity budget: a run never touches more than 30 entities', async () => {
  const store = mkStore();
  const neg = (id, n) => ({
    id, tool_id: 'ads.add_negative_keywords',
    params: { campaign_id: `c${id}`, terms: Array.from({ length: n }, (_, i) => ({ text: `${id}t${i}`, match_type: 'exact' })) },
  });
  const { results, entities_touched } = await applyChangeset({
    changes: [neg('a', 20), neg('b', 15)], ctx: baseCtx, api: okApi(), store, tenantId: 'tn', runId: 'r1', changesetId: 'cs1',
  });
  assert.strictEqual(results[0].status, 'applied');
  assert.strictEqual(results[1].status, 'failed');
  assert.match(results[1].reason, /entity budget/);
  assert.strictEqual(entities_touched, 20);
});

test('error-rate breaker: >10% failures aborts the remaining changeset', async () => {
  const store = mkStore();
  let n = 0;
  const api = new Proxy({}, {
    get: () => async () => {
      n += 1;
      if (n >= 3) throw new Error('API fell over');
      return { before: {}, after: {} };
    },
  });
  const changes = ['c1', 'c2', 'c3', 'c4', 'c5'].map((c, i) => pause(`ch${i}`, c));
  const { results, aborted } = await applyChangeset({
    changes, ctx: baseCtx, api, store, tenantId: 'tn', runId: 'r1', changesetId: 'cs1',
  });
  assert.strictEqual(aborted, true);
  assert.deepStrictEqual(results.map((r) => r.status), ['applied', 'applied', 'failed', 'aborted', 'aborted']);
  assert.ok(store._audit.some((a) => a.event === 'changeset_aborted'));
});
