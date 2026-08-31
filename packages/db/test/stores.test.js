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

test('workerStore.saveDrafts: autopilot drafts are born approved with an autopilot approval + ledger; cards are proposed', async () => {
  const f = routedFetch({
    changes: (url, init) => JSON.parse(init.body).map((r, i) => ({ id: `ch${i}`, ...r })),
    approvals: [], ledger: [],
  });
  const s = workerStore(mkDb(f));
  const out = await s.saveDrafts('run1', 't1', [
    { finding_id: 'f1', tool_id: 'ads.add_negative_keywords', params: { campaign_id: '1', terms: [] }, mode: 'autopilot', change_key: 'k1', target: 'campaign:1:negatives', category: 'negatives', before: { line: 'b' }, after: { line: 'a' }, summary: 'Excluded 2 searches', money_impact_usd: 10, watch: { kind: 'negatives', days: 7 }, baseline: { x: 1 } },
    { finding_id: 'f2', tool_id: 'ads.pause_campaign', params: { campaign_id: '2' }, mode: 'ask', reason: 'always asks', change_key: 'k2', target: 'campaign:2:status', category: null, before: { line: 'b' }, after: { line: 'a' }, summary: 'Paused X', money_impact_usd: null, watch: { kind: 'budgets', days: 14 }, baseline: {} },
  ], [{ reason: 'suspect-heavy' }]);
  assert.deepStrictEqual(out, { cards: 1, autopilot: 1, skipped: 1 });
  const ins = f.calls.find((c) => c.url.endsWith('/changes')).body;
  assert.deepStrictEqual({ s0: ins[0].status, a0: ins[0].actor, s1: ins[1].status, r1: ins[1].ask_reason, wp: ins[0].watch_plan.days }, { s0: 'approved', a0: 'autopilot', s1: 'proposed', r1: 'always asks', wp: 7 });
  const appr = f.calls.find((c) => c.url.endsWith('/approvals'));
  assert.strictEqual(appr.body[0].channel, 'autopilot');
  const events = f.calls.filter((c) => c.url.endsWith('/ledger')).map((c) => c.body[0].event);
  assert.deepStrictEqual(events, ['autopilot_applied', 'fix_proposed', 'engine_paused']);
});

test('workerStore.closeChangeWatch: writes outcome + effect; tracking breakage auto-reverts', async () => {
  const f = routedFetch({ watches: [], ledger: [], changes: (url, init) => (init.method === 'POST' ? [{ id: 'rb1' }] : []) });
  const s = workerStore(mkDb(f));
  await s.closeChangeWatch({
    tenantId: 't1', watch: { id: 'w1' }, change: { id: 'c1', tool_id: 'ads.set_action_secondary', params: { conversion_action_id: '5' }, summary_text: 'Set X secondary', change_key: 'k', target: 'ca:5' },
    verdict: { outcome: 'regressed', effect: { conversions: 0 }, line: 'Conversions fell', tracking_breakage: true },
    rollback: { tool_id: 'ads.set_action_primary', params: { conversion_action_id: '5' } },
  });
  const w = f.calls.find((c) => c.method === 'PATCH' && c.url.includes('watches'));
  assert.deepStrictEqual({ o: w.body.outcome, e: w.body.effect, st: w.body.status }, { o: 'regressed', e: { conversions: 0 }, st: 'resolved' });
  const rb = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/changes')).body[0];
  assert.deepStrictEqual({ t: rb.tool_id, st: rb.status, a: rb.actor, rev: rb.reverts_change_id }, { t: 'ads.set_action_primary', st: 'approved', a: 'system', rev: 'c1' });
  const events = f.calls.filter((c) => c.url.endsWith('/ledger')).map((c) => c.body[0].event);
  assert.deepStrictEqual(events, ['watch_regressed', 'auto_reverted']);
});

test('dashStore.requestRevert: reverse change born approved; autopilot origin → standing exception; finding suspect', async () => {
  const { dashStore } = require('../src/stores');
  const original = { id: 'c1', tenant_id: 't1', status: 'applied', actor: 'autopilot', tool_id: 'ads.add_negative_keywords', finding_id: 'f1', change_key: 'k1', target: 'campaign:1:negatives', summary_text: 'Excluded 2 searches', params: { campaign_id: '1', terms: [] }, after: { resource_names: ['customers/1/campaignCriteria/1~2'], line: 'excluded' }, before: { line: 'running' } };
  const f = routedFetch({
    audit_log: [], approvals: [], ledger: [], findings: [], standing_exceptions: [],
    changes: (url, init) => (init.method === 'POST' ? [{ id: 'rb1' }] : init.method === 'GET' ? [original] : []),
  });
  const r = await dashStore(mkDb(f)).requestRevert('t1', 'c1');
  assert.deepStrictEqual(r, { ok: true, rollback_change_id: 'rb1' });
  const rb = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/changes')).body[0];
  assert.deepStrictEqual({ t: rb.tool_id, names: rb.params.resource_names, st: rb.status, rev: rb.reverts_change_id }, { t: 'ads.remove_negative_keywords', names: ['customers/1/campaignCriteria/1~2'], st: 'approved', rev: 'c1' });
  assert.ok(f.calls.some((c) => c.url.endsWith('/standing_exceptions') && c.body[0].change_key === 'k1'));
  assert.ok(f.calls.some((c) => c.method === 'PATCH' && c.url.includes('findings') && c.body.status === 'suspect'));
  // non-applied → refused
  const g = routedFetch({ audit_log: [], changes: [{ ...original, status: 'proposed' }] });
  assert.strictEqual((await dashStore(mkDb(g)).requestRevert('t1', 'c1')).ok, false);
});

test('workerStore.draftState: consent flags, exception + inflight + recent sets, weekly budget delta', async () => {
  const f = routedFetch({
    autopilot_settings: [{ categories: { negatives: true, budgets: false, counting: 'auto' } }],
    standing_exceptions: [{ change_key: 'ex1' }],
    changes: (url) => (url.includes('status=in.(proposed,approved)') ? [{ target: 'campaign:1:budget' }]
      : url.includes('status=eq.applied&applied_at') && !url.includes('adjust_budget') ? [{ change_key: 'r1' }]
      : url.includes('adjust_budget') ? [{ params: { new_daily_usd: 12, previous_daily_usd: 10 } }]
      : url.includes('status=eq.reverted') ? [{ id: 'x' }, { id: 'y' }] : []),
    campaigns: [{ google_campaign_id: '1', budget_daily_usd: '10' }, { google_campaign_id: '2', budget_daily_usd: '10' }],
  });
  const st = await workerStore(mkDb(f)).draftState('t1');
  assert.deepStrictEqual(st.autopilot, { negatives: true, budgets: false, counting: true });
  assert.ok(st.exceptions.has('ex1') && st.inflight.has('campaign:1:budget') && st.recent.has('r1'));
  assert.deepStrictEqual({ d: st.bounds.weekly_budget_delta_pct, rv: st.bounds.reverted_30d, tot: st.bounds.account.daily_budget_total_usd }, { d: 10, rv: 2, tot: 20 });
  assert.strictEqual(st.bounds.campaign('2').budget_daily_usd, 10);
});

test('dashStore.confirmAssets links only crawl-matched / owner-selected assets, never the "other items"', async () => {
  // Regression: 31 Aug 2026 - confirming linked every discovered asset, including a
  // sibling business's Ads account visible under the same Google login.
  const { dashStore } = require('../src/stores');
  const f = stubFetch([{ status: 204 }]);
  await dashStore(mkDb(f)).confirmAssets('t1');
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].method, 'PATCH');
  assert.match(f.calls[0].url, /assets\?tenant_id=eq\.t1/);
  assert.match(decodeURIComponent(f.calls[0].url), /metadata->>matched_via=not\.is\.null/);
  assert.deepStrictEqual(f.calls[0].body, { linked: true });
});

test('dashStore.settings: connection status comes from the tenant owner\'s google_connections row', async () => {
  // Regression: 31 Aug 2026 - the query used a SQL subquery PostgREST rejects,
  // so Settings read "Google connection pending." for every tenant, always.
  const { dashStore } = require('../src/stores');
  const mk = (status) => routedFetch({
    subscriptions: [], autopilot_settings: [], tenants: [{ assistant_enabled: false }],
    users: (url) => (url.includes('tenant_id=eq.t1') ? [{ id: 'u1' }] : []),
    google_connections: (url) => (url.includes('user_id=eq.u1') ? [{ status }] : []),
  });
  assert.strictEqual((await dashStore(mkDb(mk('valid'))).settings('t1')).connection_status, 'Google connection healthy.');
  assert.match((await dashStore(mkDb(mk('revoked'))).settings('t1')).connection_status, /removed/);
  const none = routedFetch({ subscriptions: [], autopilot_settings: [], tenants: [], users: [] });
  assert.strictEqual((await dashStore(mkDb(none)).settings('t1')).connection_status, 'Google connection pending.');
});
