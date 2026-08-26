const assert = require('node:assert');
const { test } = require('node:test');
const { createTelemetry, modelCost, textDiff } = require('../src/telemetry');

function fakeDb({ failOn = null } = {}) {
  const writes = [];
  const rows = { model_usage: null, telemetry_heartbeat: null };
  return {
    writes,
    insert: async (table, r) => { if (table === failOn) throw new Error('boom'); writes.push({ op: 'insert', table, rows: r }); },
    upsert: async (table, r, on) => { if (table === failOn) throw new Error('boom'); writes.push({ op: 'upsert', table, rows: r, on }); if (table === 'model_usage') rows.model_usage = r[0]; },
    select: async (table) => rows[table] || null,
    update: async () => {},
  };
}

test('event: validates names, writes row + heartbeat', async () => {
  const db = fakeDb();
  const tel = createTelemetry({ db });
  assert.strictEqual(await tel.event({ tenantId: 't', name: 'Bad Name' }), false);
  assert.strictEqual(await tel.event({ tenantId: 't', name: 'screen.view', props: { path: '/app' } }), true);
  assert.strictEqual(db.writes[0].table, 'events');
  assert.strictEqual(db.writes[1].table, 'telemetry_heartbeat');
  assert.strictEqual(db.writes[1].rows[0].stream, 'events');
});

test('writes never throw; failure returns false and skips the heartbeat', async () => {
  const db = fakeDb({ failOn: 'dismissals' });
  const tel = createTelemetry({ db });
  assert.strictEqual(await tel.dismissal({ tenantId: 't', reasonTap: 'wrong' }), false);
  assert.strictEqual(db.writes.length, 0);
});

test('dismissal: unknown reason taps become null, expanded_first is boolean', async () => {
  const db = fakeDb();
  await createTelemetry({ db }).dismissal({ tenantId: 't', reasonTap: 'lol', expandedFirst: 1 });
  assert.deepStrictEqual({ r: db.writes[0].rows[0].reason_tap, e: db.writes[0].rows[0].expanded_first }, { r: null, e: true });
});

test('modelUsage: monthly aggregate accumulates', async () => {
  const db = fakeDb();
  const tel = createTelemetry({ db });
  const now = new Date('2026-08-26T00:00:00Z');
  await tel.modelUsage({ tenantId: 't', inputTokens: 1000, outputTokens: 100, costUsd: 0.015, now });
  await tel.modelUsage({ tenantId: 't', inputTokens: 1000, outputTokens: 100, costUsd: 0.015, now });
  const last = db.writes.filter((w) => w.table === 'model_usage').at(-1).rows[0];
  assert.deepStrictEqual({ m: last.month, c: last.calls, i: last.input_tokens, cost: last.cost_usd }, { m: '2026-08-01', c: 2, i: 2000, cost: 0.03 });
});

test('modelCost: list prices, cached discount, unpriced = 0', () => {
  assert.strictEqual(modelCost({ inputTokens: 1_000_000, outputTokens: 0, priceIn: 10, priceOut: 50 }), 10);
  assert.strictEqual(modelCost({ inputTokens: 1000, outputTokens: 100, priceIn: 10, priceOut: 50 }), 0.015);
  assert.strictEqual(modelCost({ inputTokens: 1000, outputTokens: 0, cachedTokens: 1000, priceIn: 10, priceOut: 50 }), 0.001);
  assert.strictEqual(modelCost({ inputTokens: 1000, outputTokens: 100, priceIn: null, priceOut: null }), 0);
});

test('assetSnapshot: only headline/description rows, upserted per month', async () => {
  const db = fakeDb();
  await createTelemetry({ db }).assetSnapshot({ tenantId: 't', runId: 'r', month: '2026-08-01', assets: [
    { text: 'A', type: 'headline', campaign_id: '1', impressions_30d: 5, pinned: true, performance_label: 'BEST' },
    { text: 'B', type: 'sitelink', campaign_id: '1' },
  ] });
  const w = db.writes.find((x) => x.table === 'asset_perf_snapshots');
  assert.strictEqual(w.rows.length, 1);
  assert.strictEqual(w.on, 'tenant_id,month,campaign_ref,asset_type,text');
});

test('textDiff: unchanged vs edited', () => {
  assert.strictEqual(textDiff('same', 'same').changed, false);
  assert.strictEqual(textDiff('Gel nails AED 99', 'Gel nails AED 89').changed, true);
});
