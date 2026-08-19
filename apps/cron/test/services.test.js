const assert = require('node:assert');
const { test } = require('node:test');
const cron = require('../src/service');
const poller = require('../../poller/src/service');

// Sunday 23 Aug 2026, 22:30 Gulf (18:30 UTC) — end of window, every slot due.
const SUNDAY_LATE = Date.parse('2026-08-23T18:30:00Z');
const MONDAY = Date.parse('2026-08-24T18:30:00Z');

function cronStore(over = {}) {
  const inserted = [];
  const existing = new Set(over.existingKeys || []);
  return {
    inserted,
    activeTenants: async () => over.tenants || [{ id: 'tn1' }, { id: 'tn2' }],
    runExists: async (key) => existing.has(key),
    insertRun: async (row) => { inserted.push(row); return { id: `run-${inserted.length}`, ...row }; },
    subscriptionFor: async () => over.sub || { tier: 'core', status: 'active' },
    lastDeepRunAt: async () => over.lastDeep !== undefined ? over.lastDeep : new Date(SUNDAY_LATE - 5 * 86_400_000).toISOString(),
    connectionsForSweep: async () => over.conns || [],
  };
}

test('cron: Sunday window enqueues one weekly run per tenant, idempotent across ticks', async () => {
  const store = cronStore();
  const enqueued = [];
  const deps = { store, queue: { enqueue: async (qn, r) => enqueued.push(r) }, sweep: { validate: async () => {} }, now: SUNDAY_LATE };
  const first = await cron.tick(deps);
  assert.strictEqual(first.weekly, 2);
  // Second tick same evening: keys now exist.
  const store2 = cronStore({ existingKeys: store.inserted.map((r) => r.idempotency_key) });
  const second = await cron.tick({ ...deps, store: store2 });
  assert.strictEqual(second.weekly, 0, 'no duplicates');
  assert.strictEqual((await cron.tick({ ...deps, store: cronStore(), now: MONDAY })).weekly, 0, 'Monday silent');
});

test('cron: deep audits respect anniversaries; token sweep validates due connections', async () => {
  const dueDeep = cronStore({ lastDeep: new Date(SUNDAY_LATE - 35 * 86_400_000).toISOString(), tenants: [{ id: 'tn1' }] });
  const swept = [];
  const r = await cron.tick({
    store: { ...dueDeep, connectionsForSweep: async () => [{ id: 'g1', status: 'valid', last_validated_at: '2026-08-01T00:00:00Z' }] },
    queue: { enqueue: async () => {} },
    sweep: { validate: async (c) => swept.push(c.id) },
    now: MONDAY, // deep audits are not Sunday-gated
  });
  assert.strictEqual(r.deep, 1);
  assert.deepStrictEqual(swept, ['g1']);
});

test('poller: dispatches by kind, patches status, one broken watch never blocks the rest', async () => {
  const patched = [];
  const store = {
    dueWatches: async () => [
      { id: 'w1', kind: 'tag_alive' },
      { id: 'w2', kind: 'changeset_verify' },
      { id: 'w3', kind: 'tag_alive' },
    ],
    patchWatch: async (id, patch) => patched.push({ id, ...patch }),
  };
  const handlers = {
    tag_alive: async (w) => (w.id === 'w1' ? { triggered: true } : (() => { throw new Error('crawler died'); })()),
    changeset_verify: async () => ({ resolved: true }),
  };
  const r = await poller.tick({ store, handlers, now: MONDAY });
  assert.deepStrictEqual(r, { checked: 3, triggered: 1, resolved: 1, errors: 1 });
  assert.strictEqual(patched.find((p) => p.id === 'w1').status, 'triggered');
  assert.strictEqual(patched.find((p) => p.id === 'w2').status, 'resolved');
  assert.ok(patched.find((p) => p.id === 'w3'), 'errored watch still stamped last_check_at');
});
