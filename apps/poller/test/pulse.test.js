const assert = require('node:assert');
const { test } = require('node:test');
const { pumpDailyPulse } = require('../src/pulse');

function fakeDb({ lastPulse = null, existingKinds = [] } = {}) {
  const writes = [];
  return {
    writes,
    select: async (table, query, opts) => {
      if (table === 'assets') return [{ tenant_id: 't1' }];
      if (table === 'pulse_state') return lastPulse ? [{ tenant_id: 't1', last_pulse_at: lastPulse }] : [];
      if (table === 'rule_config') return { thresholds: { spike_min_usd: 10 }, enabled: true };
      if (table === 'alerts') return existingKinds.map((k) => ({ kind: k }));
      if (table === 'users') return { email: 'owner@x.com' };
      if (table === 'runs') return [];
      return opts && opts.single ? null : [];
    },
    insert: async (table, rows) => { writes.push({ table, rows }); return rows.map((r, i) => ({ id: `${table}${i}`, ...r })); },
    upsert: async (table, rows) => { writes.push({ table, rows }); },
  };
}
const spikePulse = { days: Array.from({ length: 8 }, (_, i) => ({ date: `2026-08-${19 + i}`, spend_usd: i === 7 ? 60 : 20, conversions: 1 })), disapproved: [] };
const now = () => Date.parse('2026-08-27T09:00:00Z');

test('daily pulse: writes alert + email + ledger, enqueues a triggered run, stamps pulse_state', async () => {
  const db = fakeDb();
  const enq = [];
  const r = await pumpDailyPulse({ db, google: { fetchPulse: async () => spikePulse }, queue: { enqueue: async (n, run) => enq.push([n, run]) }, now });
  assert.deepStrictEqual(r, { checked: 1, alerts: 1, runs: 1, errors: 0 });
  assert.deepStrictEqual(db.writes.map((w) => w.table), ['alerts', 'emails', 'ledger', 'runs', 'pulse_state']);
  assert.strictEqual(db.writes[1].rows[0].template_id, 'daily_alert');
  assert.strictEqual(db.writes[1].rows[0].to_email, 'owner@x.com');
  assert.deepStrictEqual({ t: db.writes[3].rows[0].type, key: db.writes[3].rows[0].idempotency_key }, { t: 'triggered', key: 'triggered:t1:2026-08-27' });
  assert.strictEqual(enq[0][0], 'runs-weekly');
});

test('daily pulse: once a day per account; one alert per kind per day; idle without Google', async () => {
  const fresh = fakeDb({ lastPulse: '2026-08-27T01:00:00Z' });
  assert.strictEqual((await pumpDailyPulse({ db: fresh, google: { fetchPulse: async () => spikePulse }, now })).checked, 0);
  const dup = fakeDb({ existingKinds: ['spend_spike'] });
  const r = await pumpDailyPulse({ db: dup, google: { fetchPulse: async () => spikePulse }, now });
  assert.deepStrictEqual({ a: r.alerts, runs: r.runs }, { a: 0, runs: 0 });
  assert.deepStrictEqual((await pumpDailyPulse({ db: fakeDb(), google: null, now })), { checked: 0, alerts: 0, runs: 0, errors: 0 });
});

test('daily pulse: a failing account is retried in an hour and never stalls the pump', async () => {
  const db = fakeDb();
  const r = await pumpDailyPulse({ db, google: { fetchPulse: async () => { throw new Error('PERMISSION_DENIED'); } }, now });
  assert.deepStrictEqual({ e: r.errors, a: r.alerts }, { e: 1, a: 0 });
  const st = db.writes.find((w) => w.table === 'pulse_state').rows[0];
  assert.strictEqual(st.last_error, 'PERMISSION_DENIED');
  assert.ok(st.last_pulse_at < '2026-08-27T09:00:00.000Z');
});
