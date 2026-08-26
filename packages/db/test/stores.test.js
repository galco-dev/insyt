const assert = require('node:assert');
const { test } = require('node:test');
const { createClient } = require('../src/postgrest');
const { workerStore, webStore, executorStore, billingStore } = require('../src/stores');

// Stub fetch capturing PostgREST requests and replaying canned responses.
function stubFetch(responses = []) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const next = responses.shift() || { status: 200, body: [] };
    return {
      ok: next.status < 400, status: next.status,
      json: async () => next.body, text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

const mkDb = (f) => createClient({ url: 'https://proj.supabase.co', serviceKey: 'sk', fetchImpl: f });

test('postgrest client: auth headers, single-object 406 -> null, error surfaces detail', async () => {
  const f = stubFetch([{ status: 200, body: [{ id: 1 }] }, { status: 406, body: {} }, { status: 500, body: { message: 'boom' } }]);
  const db = mkDb(f);
  const rows = await db.select('tenants', 'select=*');
  assert.deepStrictEqual(rows, [{ id: 1 }]);
  assert.strictEqual(f.calls[0].headers.apikey, 'sk');
  assert.strictEqual(f.calls[0].headers.authorization, 'Bearer sk');
  assert.strictEqual(await db.select('tenants', 'id=eq.x', { single: true }), null);
  await assert.rejects(() => db.select('tenants', 'select=*'), /500/);
});

test('workerStore: checkpoint + findings mapping onto the §1 schema', async () => {
  const f = stubFetch([{ status: 204 }, { status: 201, body: null }]);
  const s = workerStore(mkDb(f));
  await s.saveCheckpoint('r1', { completed: { a: 'ok' } });
  assert.match(f.calls[0].url, /runs\?id=eq\.r1/);
  assert.strictEqual(f.calls[0].method, 'PATCH');

  await s.saveFindings('r1', [{
    tenant_id: 'tn1', rule_id: 'ads.wasted_terms', layer: 4, severity: 'warning', status: 'open',
    title: 't', explanation: 'e', entity_key: 'wasted_terms', first_seen_run_id: 'r0',
    money: { impact_monthly_usd: 340, impact_monthly_local: { amount: 1249, currency: 'AED' } },
    payload: { locked: true, entities: [] }, fix: { available: true },
  }]);
  const row = f.calls[1].body[0];
  assert.strictEqual(row.money_impact_monthly_usd, 340);
  assert.deepStrictEqual(row.money_impact_currency_local, { amount: 1249, currency: 'AED' });
  assert.strictEqual(row.payload.entity_key, 'wasted_terms', 'entity_key persisted inside payload for dedupe');
  assert.strictEqual(row.fix_available, true);
});

test('webStore: magic link contract matches packages/emails expectations', async () => {
  const f = stubFetch([
    { status: 201 },
    { status: 200, body: { id: 9, token_hash: 'h', used_at: null, expires_at: '2027-01-01T00:00:00Z', purpose: 'view_report', target_id: 'rep1' } },
    { status: 200, body: [{}] },
  ]);
  const s = webStore(mkDb(f));
  await s.magicLinks.insertLink({ tenant_id: 'tn', purpose: 'view_report', token_hash: 'h', expires_at: 'x' });
  const row = await s.magicLinks.findByHash('h');
  assert.strictEqual(row.purpose, 'view_report');
  await s.magicLinks.markUsed(9, '2026-08-19T00:00:00Z');
  assert.match(f.calls[2].url, /magic_links\?id=eq\.9/);
});

test('executorStore: idempotency via changes.idempotency_key; ledger/audit inserts', async () => {
  const f = stubFetch([
    { status: 200, body: { id: 'ch1' } }, // key exists
    { status: 406, body: {} },            // key absent
    { status: 201 }, { status: 201 },
  ]);
  const s = executorStore(mkDb(f), { tenantId: 'tn1' });
  assert.strictEqual(await s.hasKey('tn1:r1:tool:target'), true);
  assert.strictEqual(await s.hasKey('other'), false);
  await s.ledger({ event: 'fix_applied', actor: 'system', summary_text: 'x' });
  assert.strictEqual(f.calls[2].body[0].tenant_id, 'tn1');
  await s.audit({ event: 'change_applied', detail: {} });
  assert.match(f.calls[3].url, /audit_log/);
});

test('billingStore: upsert on stripe_subscription_id, tenant lookup by customer', async () => {
  const f = stubFetch([
    { status: 201, body: [{}] },
    { status: 200, body: { tenant_id: 'tn7' } },
  ]);
  const s = billingStore(mkDb(f));
  await s.upsertSubscription({ stripe_subscription_id: 'sub_1', tenant_id: 'tn7', tier: 'core' });
  assert.match(f.calls[0].url, /subscriptions\?on_conflict=stripe_subscription_id/);
  assert.match(f.calls[0].headers.prefer, /merge-duplicates/);
  assert.strictEqual(await s.tenantIdByCustomer('cus_1'), 'tn7');
});

// Route-aware stub: answers by table so parallel selects don't depend on order.
function routedFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const table = /rest\/v1\/([a-z_]+)/.exec(url)[1];
    const r = routes[table];
    const body = typeof r === 'function' ? r(url, init) : (r === undefined ? [] : r);
    const single = init.headers && init.headers.accept === 'application/vnd.pgrst.object+json';
    if (single && Array.isArray(body) && !body.length) return { ok: false, status: 406, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 200, json: async () => (single && Array.isArray(body) ? body[0] : body), text: async () => '' };
  };
  impl.calls = calls;
  return impl;
}

test('dashStore.spendPosition: MTD from spend_daily, budget from daily budgets, honest pace line', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    spend_daily: [{ date: '2026-08-01', spend_usd: '40' }, { date: '2026-08-10', spend_usd: '60' }],
    account_targets: [],
    campaigns: [{ budget_daily_usd: '10' }],
  });
  const s = dashStore(mkDb(f));
  const now = new Date('2026-08-16T12:00:00Z'); // day 16 of 31 → 52% of month
  const spend = await s.spendPosition('t1', now);
  assert.strictEqual(spend.month_usd, 100);
  assert.strictEqual(spend.month_budget_usd, 310);
  assert.strictEqual(spend.budget_source, 'daily_budgets');
  assert.strictEqual(spend.pace_line, 'Behind pace - 32% spent, 52% of the month gone');
  assert.strictEqual(spend.as_of, '2026-08-10');
});

test('dashStore.spendPosition: explicit target wins; no snapshots → null (card stays dark)', async () => {
  const { dashStore } = require('../src/stores');
  const s = dashStore(mkDb(routedFetch({ spend_daily: [{ date: '2026-08-02', spend_usd: '500' }], account_targets: [{ monthly_budget_usd: '1000' }], campaigns: [] })));
  const spend = await s.spendPosition('t1', new Date('2026-08-16T12:00:00Z'));
  assert.deepStrictEqual({ b: spend.month_budget_usd, src: spend.budget_source }, { b: 1000, src: 'target' });
  assert.match(spend.pace_line, /^On pace - 50% spent/);
  const dark = dashStore(mkDb(routedFetch({ spend_daily: [] })));
  assert.strictEqual(await dark.spendPosition('t1'), null);
});

test('workerStore.saveSnapshots: campaigns + spend_daily upserts, draft placeholders skipped', async () => {
  const f = routedFetch({ campaigns: [], spend_daily: [], asset_perf_snapshots: [], telemetry_heartbeat: [] });
  const s = workerStore(mkDb(f));
  const r = await s.saveSnapshots('t1', {
    campaigns: [{ id: '11', name: 'Brand', status: 'enabled', budget_daily_usd: 12.345, bidding: { strategy: 'tcpa' } }, { id: 'draft-abc', name: 'x' }],
    deep: { daily: [{ date: '2026-08-01', cost_usd: 5, conversions: 1, conversion_value_usd: 0 }], assets: [{ text: 'H', type: 'headline', campaign_id: '11', impressions_30d: 3 }] },
  }, 'run1');
  assert.deepStrictEqual(r, { campaigns: 1, days: 1, assets: 1 });
  const camp = f.calls.find((c) => c.url.includes('campaigns?on_conflict=tenant_id,google_campaign_id'));
  assert.deepStrictEqual({ id: camp.body[0].google_campaign_id, b: camp.body[0].budget_daily_usd, bid: camp.body[0].bidding }, { id: '11', b: 12.35, bid: 'tcpa' });
  assert.ok(f.calls.some((c) => c.url.includes('spend_daily?on_conflict=tenant_id,date')));
  assert.ok(f.calls.some((c) => c.url.includes('asset_perf_snapshots?on_conflict=')));
});

test('dashStore.dismissChange: records the §11.2 dismissal label without breaking the dismissal itself', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({ changes: [{ finding_id: 'f1', finding: { rule_id: 'ads.wasted_terms' } }], findings: [], dismissals: [], telemetry_heartbeat: [] });
  await dashStore(mkDb(f)).dismissChange('t1', 'c1', { reason: 'not_now', expandedFirst: true });
  const d = f.calls.find((c) => c.url.endsWith('/dismissals'));
  assert.deepStrictEqual({ r: d.body[0].reason_tap, e: d.body[0].expanded_first, rule: d.body[0].rule_id }, { r: 'not_now', e: true, rule: 'ads.wasted_terms' });
});
