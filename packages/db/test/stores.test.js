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

test('dashStore.overview: money strip, the week from changes + watches, three accounts, one round trip', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    spend_daily: [{ date: '2026-09-01', spend_usd: '40', conversions: '2' }, { date: '2026-09-08', spend_usd: '60', conversions: '1' }],
    account_targets: [],
    campaigns: [{ budget_daily_usd: '10' }],
    reports: [{ id: 'rep1', created_at: '2026-09-06T03:00:00Z', summary: { waste_monthly_usd: 430.4, counts: { critical: 1, warning: 4, info: 2 } }, findings_snapshot: [] }],
    ledger_cumulative: [{ tenant_id: 't1', fixes_applied: 6, waste_removed_usd: '730.2' }],
    changes: [
      { id: 'c1', changeset_id: 'cs1', applied_at: '2026-09-07T10:00:00Z' },
      { id: 'c2', changeset_id: 'cs1', applied_at: '2026-09-07T10:00:00Z' },
      { id: 'c3', changeset_id: 'cs2', applied_at: '2026-09-09T10:00:00Z' },
    ],
    watches: [{ target_id: 'cs1', status: 'resolved' }, { target_id: 'cs2', status: 'active' }],
    runs: [{ id: 'r2', type: 'weekly', status: 'complete', finished_at: '2026-09-06T03:10:00Z' }, { id: 'r1', type: 'signup_audit', status: 'degraded', finished_at: '2026-08-30T03:10:00Z' }],
    assets: [{ kind: 'ads_account', external_id: '6424596144', display_name: 'JobPeak' }, { kind: 'gtm_container', external_id: 'GTM-KR92FJZS', display_name: null }],
    users: [{ id: 'u1' }],
    google_connections: [{ status: 'valid' }],
    alerts: [{ id: 'a1', severity: 'warning', kind: 'spend_spike', title: 'Yesterday cost 2.4x a normal day', created_at: '2026-09-09T06:00:00Z', acked_at: '2026-09-09T07:00:00Z' }, { id: 'a2', severity: 'critical', kind: 'tag_down', title: 'Tracking stopped', created_at: '2026-09-08T06:00:00Z', acked_at: null }],
    ledger: [{ summary_text: 'Excluded 14 searches', created_at: '2026-09-07T10:00:00Z' }],
  });
  const s = dashStore(mkDb(f));
  const o = await s.overview('t1', new Date('2026-09-10T12:00:00Z')); // a Thursday: 3 days to Sunday

  assert.strictEqual(o.spend.month_usd, 100);
  assert.strictEqual(o.waste_monthly_usd, 430);
  assert.deepStrictEqual(o.recovered, { fixes: 6, usd: 730 });
  assert.deepStrictEqual(o.this_week, {
    last_check_at: '2026-09-06T03:10:00Z', last_check_type: 'weekly', findings: 7, next_check_days: 3,
    applied: 3, verified: 2, watching: 1, reverted: 0,
  });
  assert.deepStrictEqual(o.accounts.map((a) => [a.kind, a.status, a.name, a.read_at]), [
    ['ads_account', 'ok', 'JobPeak', '2026-09-06T03:10:00Z'],
    ['ga4_property', 'unmatched', null, null],
    ['gtm_container', 'ok', 'GTM-KR92FJZS', '2026-09-06T03:10:00Z'],
  ]);
  assert.deepStrictEqual(o.alerts.map((a) => a.id), ['a2', 'a1'], 'unacknowledged alerts first');
  assert.strictEqual(o.performance.days.length, 2);
  assert.deepStrictEqual(o.performance.fixes, [{ at: '2026-09-07T10:00:00Z', title: 'Excluded 14 searches' }]);
  // Every query is tenant-scoped and single-table: no `in.(select` anywhere.
  for (const c of f.calls) assert.ok(!/in\.\(select/.test(c.url), c.url);
  const watchCall = f.calls.find((c) => /watches/.test(c.url));
  assert.match(watchCall.url, /target_id=in\.\(cs1,cs2\)/);
});

test('dashStore.overview: brand-new tenant (no report, no run, no spend) renders honest empties', async () => {
  const { dashStore } = require('../src/stores');
  const s = dashStore(mkDb(routedFetch({ users: [{ id: 'u1' }], google_connections: [{ status: 'expired' }], assets: [{ kind: 'gtm_container', external_id: 'GTM-1', display_name: null }] })));
  const o = await s.overview('t1', new Date('2026-09-13T12:00:00Z')); // Sunday
  assert.strictEqual(o.spend, null);
  assert.strictEqual(o.waste_monthly_usd, null);
  assert.deepStrictEqual(o.recovered, { fixes: 0, usd: 0 });
  assert.strictEqual(o.this_week.last_check_at, null);
  assert.strictEqual(o.this_week.findings, null);
  assert.strictEqual(o.this_week.next_check_days, 0);
  assert.strictEqual(o.accounts.find((a) => a.kind === 'gtm_container').status, 'reconnect');
  assert.deepStrictEqual(o.alerts, []);
});

test('dashStore.approveBatch: one yes per id via approveChange, de-duplicated, a bad id never blocks the rest', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    changes: (url) => (/id=eq\.bad/.test(url) ? [] : [{ tool_id: 'ads.negatives', params: {}, status: 'proposed' }]),
    approvals: [], events: [], telemetry_heartbeat: [],
  });
  const s = dashStore(mkDb(f));
  const r = await s.approveBatch('t1', ['c1', 'c2', 'c1', 'bad']);
  assert.deepStrictEqual(r, { approved: 3, requested: 3 });
  const patches = f.calls.filter((c) => c.method === 'PATCH' && /changes\?id=eq\.c[12]/.test(c.url));
  assert.strictEqual(patches.length, 2, 'c1 approved once, c2 once');
  for (const c of patches) assert.match(c.url, /tenant_id=eq\.t1&status=eq\.proposed/);
});

test('dashStore.receipts: verdict from the per-change watch, the 48h changeset watch as fallback, reverts say why', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    changes: (url) => (/status=eq\.failed/.test(url) ? [] : [
      { id: 'c1', finding_id: 'f1', applied_at: '2026-09-03T10:00:00Z', changeset_id: 'cs1', status: 'applied' },
      { id: 'c2', finding_id: 'f2', applied_at: '2026-09-03T10:00:00Z', changeset_id: 'cs1', status: 'applied' },
      { id: 'c3', finding_id: 'f3', applied_at: '2026-09-08T10:00:00Z', changeset_id: 'cs2', status: 'reverted' },
      { id: 'c4', finding_id: null, applied_at: '2026-09-09T10:00:00Z', changeset_id: 'cs3', status: 'applied' },
    ]),
    watches: [
      { target_id: 'c1', kind: 'change_verify', status: 'resolved', outcome: 'verified', closed_at: '2026-09-05T10:00:00Z', schedule: {} },
      { target_id: 'cs1', kind: 'changeset_verify', status: 'resolved', outcome: null, closed_at: null, schedule: { until: '2026-09-05T10:00:00Z' } },
      { target_id: 'cs3', kind: 'changeset_verify', status: 'active', outcome: null, closed_at: null, schedule: { until: '2026-09-11T10:00:00Z' } },
    ],
    ledger: [
      { change_id: 'c1', event: 'watch_verified', summary_text: 'Excluded 14 searches: Wasted-term clicks down 92% over 48 hours', created_at: '2026-09-05T10:00:00Z' },
      { change_id: 'c3', event: 'fix_reverted', summary_text: 'Undid the budget change: Cost per result rose to $41 (from $22)', created_at: '2026-09-09T10:00:00Z' },
    ],
  });
  const s = dashStore(mkDb(f));
  const r = await s.receipts('t1', new Date('2026-09-10T12:00:00Z'));
  assert.deepStrictEqual(r.by_change.c1, { change_id: 'c1', finding_id: 'f1', applied_at: '2026-09-03T10:00:00Z', state: 'verified', verified_at: '2026-09-05T10:00:00Z', line: 'Wasted-term clicks down 92% over 48 hours', watch_until: null });
  assert.strictEqual(r.by_change.c2.state, 'verified', 'no own watch: the resolved changeset watch verifies it');
  assert.strictEqual(r.by_change.c2.verified_at, '2026-09-05T10:00:00Z');
  assert.deepStrictEqual([r.by_change.c3.state, r.by_change.c3.line], ['reverted', 'Cost per result rose to $41 (from $22)']);
  assert.deepStrictEqual([r.by_change.c4.state, r.by_change.c4.watch_until], ['watching', '2026-09-11T10:00:00Z']);
  assert.deepStrictEqual(Object.keys(r.by_finding).sort(), ['f1', 'f2', 'f3']);
  for (const c of f.calls) assert.ok(!/in\.\(select/.test(c.url), c.url);
  const empty = dashStore(mkDb(routedFetch({ changes: [] })));
  assert.deepStrictEqual(await empty.receipts('t1'), { by_change: {}, by_finding: {} });
});

test('dashStore.settings: weekly, emails and business cards ride on tenants + users + runs; business and email writes patch tenants', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    subscriptions: [], autopilot_settings: [],
    users: [{ id: 'u1', email: 'owner@jobpeak.net' }],
    tenants: [{ business_name: 'JobPeak', website_url: 'jobpeak.net', size_band: '10k', timezone: 'Asia/Dubai', email_reports: false, assistant_enabled: false }],
    runs: [{ id: 'r2', type: 'weekly', status: 'complete', started_at: '2026-09-06T03:00:00Z', finished_at: '2026-09-06T03:10:00Z' }],
    assets: [{ currency: 'AED' }],
    google_connections: [{ status: 'valid' }],
  });
  const s = dashStore(mkDb(f));
  const st = await s.settings('t1', new Date('2026-09-10T12:00:00Z')); // Thursday
  assert.deepStrictEqual(st.weekly, { timezone: 'Asia/Dubai', next_run_at: '2026-09-13', next_check_days: 3, last_runs: [{ id: 'r2', type: 'weekly', status: 'complete', started_at: '2026-09-06T03:00:00Z', finished_at: '2026-09-06T03:10:00Z' }] });
  assert.deepStrictEqual(st.emails, { reports: false, address: 'owner@jobpeak.net' });
  assert.deepStrictEqual(st.business, { name: 'JobPeak', website: 'jobpeak.net', currency: 'AED', band: '10k' });
  assert.strictEqual(st.connection_status, 'Google connection healthy.');

  const r = await s.setBusiness('t1', { name: '  Job Peak ', website: 'https://www.jobpeak.net/about', timezone: 'Europe/London' });
  assert.deepStrictEqual(r, { ok: true, business_name: 'Job Peak', website_url: 'www.jobpeak.net', timezone: 'Europe/London' });
  const patch = f.calls.find((c) => c.method === 'PATCH' && /tenants\?id=eq\.t1/.test(c.url));
  assert.deepStrictEqual(patch.body, { business_name: 'Job Peak', website_url: 'www.jobpeak.net', timezone: 'Europe/London' });
  assert.deepStrictEqual(await s.setBusiness('t1', { timezone: 'not a zone' }), { ok: false }, 'a bad timezone is ignored, not stored');
  assert.deepStrictEqual(await s.setEmailReports('t1', 0), { ok: true, reports: false });
});

test('dashStore.assistantEnabled: on with an active plan, off without one, tenants.assistant_enabled overrides either way', async () => {
  const { dashStore } = require('../src/stores');
  const mk = (tenant, sub) => dashStore(mkDb(routedFetch({ tenants: tenant ? [tenant] : [], subscriptions: sub ? [sub] : [] })), { assistant: {} });
  assert.strictEqual(await mk({ assistant_enabled: null }, { status: 'active' }).assistantEnabled('t1'), true);
  assert.strictEqual(await mk({ assistant_enabled: null }, { status: 'past_due' }).assistantEnabled('t1'), true, 'grace ladder degrades, never cuts');
  assert.strictEqual(await mk({ assistant_enabled: null }, null).assistantEnabled('t1'), false);
  assert.strictEqual(await mk({ assistant_enabled: false }, { status: 'active' }).assistantEnabled('t1'), false, 'explicit off wins');
  assert.strictEqual(await mk({ assistant_enabled: true }, null).assistantEnabled('t1'), true, 'explicit on wins');
  const noBot = dashStore(mkDb(routedFetch({ tenants: [{ assistant_enabled: true }], subscriptions: [{ status: 'active' }] })));
  assert.strictEqual(await noBot.assistantEnabled('t1'), false, 'no assistant wired: never on');
  const f = routedFetch({ alerts: [] });
  await dashStore(mkDb(f)).ackAlert('t1', 'al1');
  assert.match(f.calls[0].url, /alerts\?id=eq\.al1&tenant_id=eq\.t1/);
  assert.ok(f.calls[0].body.acked_at);
});

test('workerStore: saveReport returns the id, mintReportLinks stores hashes only, notifyReport queues audit_ready with a report link', async () => {
  const f = routedFetch({ payments: [], reports: (url, init) => (init.method === 'POST' ? [{ id: 'rep-9' }] : []), magic_links: [], users: [{ email: 'owner@jobpeak.net' }], tenants: [{ website_url: 'jobpeak.net', email_reports: true }], emails: [] });
  const s = workerStore(mkDb(f));
  assert.strictEqual(await s.saveReport('r1', { id: 'rep-9', html_email: '<p/>', html_web: '<p/>', findings_snapshot: [], tenant_id: 't1', type: 'signup' }), 'rep-9');
  const links = await s.mintReportLinks('t1', 'rep-9', { baseUrl: 'https://app', now: 1_000, pendingCount: 2 });
  assert.match(links.view_url, /^https:\/\/app\/m\/[A-Za-z0-9_-]{40,}$/);
  assert.match(links.approve_url, /^https:\/\/app\/m\//);
  const linkRows = f.calls.filter((c) => /magic_links/.test(c.url) && c.method === 'POST');
  assert.strictEqual(linkRows.length, 2);
  assert.deepStrictEqual(linkRows.map((c) => c.body[0].purpose), ['view_report', 'approve_all']);
  assert.ok(linkRows.every((c) => /^[0-9a-f]{64}$/.test(c.body[0].token_hash)), 'only the hash is stored');
  const r = await s.notifyReport({ tenantId: 't1', reportId: 'rep-9', type: 'signup', summary: { health_score: 58.4, waste_monthly_usd: 430.2 }, issueCount: 7, pendingCount: 2, links });
  assert.deepStrictEqual(r, { queued: true, template: 'audit_ready' });
  const email = f.calls.find((c) => /emails/.test(c.url) && c.method === 'POST').body[0];
  assert.strictEqual(email.template_id, 'audit_ready');
  assert.strictEqual(email.to_email, 'owner@jobpeak.net');
  assert.deepStrictEqual(email.payload, { issue_count: 7, site: 'jobpeak.net', health_score: 58, waste_monthly: '$430', report_url: links.view_url });
  const { renderTemplate } = require('../../emails/src/templates');
  assert.doesNotThrow(() => renderTemplate('audit_ready', email.payload), 'every variable the template needs is there');
});

test('dashStore.access carries fix_access; pendingApprovals flags analytics and tracking changes', async () => {
  const { dashStore } = require('../src/stores');
  const mk = (conn) => dashStore(mkDb(routedFetch({ payments: [], subscriptions: [], tenants: [], pricing_config: [], reports: [], changes: [], assets: [], users: [{ id: 'u1' }], google_connections: conn ? [conn] : [] })));
  assert.strictEqual((await mk({ status: 'valid', scope_level: 'write' }).access('t1')).fix_access, 'ready');
  assert.strictEqual((await mk({ status: 'valid', scope_level: 'readonly' }).access('t1')).fix_access, 'ask');
  assert.strictEqual((await mk({ status: 'expired', scope_level: 'write' }).access('t1')).fix_access, 'reconnect');
  assert.strictEqual((await mk(null).access('t1')).fix_access, 'reconnect');
  const s = dashStore(mkDb(routedFetch({ assets: [], changes: [
    { id: 'c1', tool_id: 'ads.add_negative_keywords', summary_text: 'Excluded 3 searches', finding: null },
    { id: 'c2', tool_id: 'ga4.set_retention', summary_text: 'Set data retention to 14 months', finding: null },
    { id: 'c3', tool_id: 'settings.autopilot_on', summary_text: 'Autopilot on', finding: null },
  ] })));
  const rows = await s.pendingApprovals('t1');
  assert.deepStrictEqual(rows.map((r) => [r.id, r.needs_fix_access]), [['c1', false], ['c2', true], ['c3', false]]);
});

test('dashStore.discovery: three doors with honest states; confirmAssets links the choice and writes fences', async () => {
  const { dashStore } = require('../src/stores');
  const assets = [
    { id: 'g1', kind: 'gtm_container', external_id: 'GTM-1', display_name: null, linked: false, metadata: { matched_via: 'container_on_site' } },
    { id: 'p1', kind: 'ga4_property', external_id: '55', display_name: 'Site', linked: false, metadata: { matched_via: 'stream_match' } },
    { id: 'ad1', kind: 'ads_account', external_id: '111', display_name: 'Main', linked: false, metadata: { spend_30d_usd: 900, campaigns: [{ id: '7', name: 'Brand', status: 'enabled', spend_30d_usd: 300 }] } },
    { id: 'ad2', kind: 'ads_account', external_id: '222', display_name: 'Old', linked: false, metadata: { spend_30d_usd: 0, campaigns: [] } },
  ];
  const f = routedFetch({ assets: (url) => (/id=eq\.ad1/.test(url) ? [assets[2]] : assets), tenants: [{ website_url: 'jobpeak.net' }], crawls: [{ tags_found: { gtm_containers: ['GTM-1'], ga4_ids: ['G-1'], aw_conversion_ids: [] } }], standing_exceptions: [] });
  const s = dashStore(mkDb(f));
  const d = await s.discovery('t1');
  assert.deepStrictEqual([d.doors.gtm_container.state, d.doors.ga4_property.state, d.doors.ads_account.state], ['matched', 'matched', 'choose']);
  assert.strictEqual(d.doors.ads_account.suggested, 'ad1', 'the account with spend is pre-ticked');
  assert.deepStrictEqual(d.campaigns, [{ id: '7', name: 'Brand', status: 'enabled', spend_30d_usd: 300 }]);
  assert.strictEqual(d.no_access, false);

  const r = await s.confirmAssets('t1', { link: ['ad1'], exceptions: [{ target: 'campaign:7', summary_text: 'Leave "Brand" alone' }, { target: 'drop table', summary_text: 'x' }] });
  assert.deepStrictEqual(r, { linked: 1, fenced: 1 });
  const linkPatch = f.calls.find((c) => c.method === 'PATCH' && /assets\?id=eq\.ad1/.test(c.url));
  assert.strictEqual(linkPatch.body.linked, true);
  assert.strictEqual(linkPatch.body.metadata.matched_via, 'owner_choice');
  const fence = f.calls.find((c) => c.method === 'POST' && /standing_exceptions/.test(c.url)).body[0];
  assert.deepStrictEqual([fence.change_key, fence.target, fence.created_from], ['fence:campaign:7', 'campaign:7', 'ui']);

  const none = dashStore(mkDb(routedFetch({ assets: [], tenants: [{ website_url: 'x.com' }], crawls: [] })));
  const e = await none.discovery('t1');
  assert.strictEqual(e.no_access, true);
  assert.strictEqual(e.doors.ads_account.state, 'cannot_see');
  assert.strictEqual(e.doors.gtm_container.state, 'unused');
});

test('dashStore.overview (fix plan moves 3 and 8): unused vs unmatched doors, site signals, an open or failed check', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    spend_daily: [], account_targets: [], campaigns: [], reports: [], ledger_cumulative: [], changes: [], alerts: [], ledger: [], watches: [],
    runs: (url) => (/status=in\.\(queued/.test(url) ? [{ id: 'r9', type: 'signup_audit', status: 'running', started_at: '2026-09-12T08:00:00Z', finished_at: null }] : []),
    assets: [{ kind: 'gtm_container', external_id: 'GTM-1', display_name: null }],
    users: [{ id: 'u1' }], google_connections: [{ status: 'valid' }],
    tenants: [{ website_url: 'glowstudio.ae' }],
    crawls: [{ tags_found: { gtm_containers: ['GTM-1'], ga4_ids: [], aw_conversion_ids: [], seen: { consent_tool: 'Cookiebot', other_tools: ['Meta'], contact: { whatsapp: true, phone: false }, server_side_gtm: false } } }],
  });
  const o = await dashStore(mkDb(f)).overview('t1', new Date('2026-09-12T08:30:00Z'));
  assert.deepStrictEqual(o.accounts.map((a) => [a.kind, a.status]), [['ads_account', 'unmatched'], ['ga4_property', 'unused'], ['gtm_container', 'ok']]);
  assert.deepStrictEqual(o.site, { consent_tool: 'Cookiebot', other_tools: ['Meta'], whatsapp: true, phone: false, server_side_gtm: false });
  assert.deepStrictEqual(o.running, { since: '2026-09-12T08:00:00Z', type: 'signup_audit' });
  assert.strictEqual(o.failed_last, false);
  const { accessFrom } = require('../../billing/src/access');
  assert.strictEqual(accessFrom({ paid: null, sub: null, tenant: null, pricing: null, report: { summary: { counts: { critical: 0, warning: 0, info: 0 } } }, pending: [], ads: null }).findings_count, 0);
  assert.strictEqual(accessFrom({ paid: null, sub: null, tenant: null, pricing: null, report: null, pending: [], ads: null }).findings_count, null);
});

test('dashStore (fix plan push 4): snoozed cards stay out, list-shaped cards carry their items and a fence, partial yes trims the terms', async () => {
  const { dashStore } = require('../src/stores');
  const terms = [{ text: 'free stuff', match_type: 'exact' }, { text: 'jobs', match_type: 'phrase' }, { text: 'diy kit', match_type: 'exact' }];
  const f = routedFetch({
    assets: [],
    campaigns: [{ google_campaign_id: '11', name: 'Brand - Dubai' }],
    changes: (url, init) => (init.method === 'GET' ? [{ id: 'c1', tool_id: 'ads.add_negative_keywords', params: { campaign_id: '11', terms }, target: 'campaign:11:negatives', summary_text: 'Excluded 3 searches', status: 'proposed', finding: null }] : []),
  });
  const s = dashStore(mkDb(f));
  const rows = await s.pendingApprovals('t1');
  assert.ok(f.calls.some((c) => /changes/.test(c.url) && /snoozed_until/.test(decodeURIComponent(c.url))), 'snoozed cards are filtered on the server');
  assert.deepStrictEqual(rows[0].list, ['free stuff', 'jobs', 'diy kit']);
  assert.deepStrictEqual(rows[0].fence, { target: 'campaign:11', label: 'Brand - Dubai', summary_text: 'Leave "Brand - Dubai" alone' });

  await s.approveChange('t1', 'c1', { keep: ['free stuff', 'diy kit'] });
  const trim = f.calls.find((c) => c.method === 'PATCH' && /changes\?id=eq\.c1/.test(c.url) && c.body.params);
  assert.deepStrictEqual(trim.body.params.terms.map((t) => t.text), ['free stuff', 'diy kit']);
  assert.strictEqual(trim.body.summary_text, 'Exclude 2 searches from your ads');
  const approve = f.calls.find((c) => c.method === 'PATCH' && /status=eq\.proposed/.test(c.url) && c.body.status === 'approved');
  assert.ok(approve, 'then approved');

  const sn = await s.snoozeChange('t1', 'c1', 7);
  assert.strictEqual(sn.ok, true);
  const snooze = f.calls.find((c) => c.method === 'PATCH' && c.body.snoozed_until);
  assert.ok(snooze && /status=eq\.proposed/.test(snooze.url));
});

test('dashStore (fix plan push 4): fences from a card or Settings, retry, undo preview, failed receipts', async () => {
  const { dashStore } = require('../src/stores');
  const f = routedFetch({
    standing_exceptions: [], ledger: [], changes: (url) => (/status=eq\.failed/.test(url) ? [{ id: 'c9', finding_id: 'f9', created_at: '2026-09-10T10:00:00Z', changeset_id: 'cs9', status: 'failed' }] : /id=eq\.c5/.test(url) ? [{ tool_id: 'ads.adjust_budget', params: { campaign_id: '11', new_daily_usd: 18, previous_daily_usd: 25 }, before: { line: 'Runs on $25 a day' }, after: { line: 'Runs on $18 a day' }, summary_text: 'Lowered the budget', status: 'applied' }] : []),
    campaigns: [{ google_campaign_id: '11', name: 'Brand - Dubai', status: 'enabled', budget_daily_usd: '30' }],
    findings: [], dismissals: [], events: [], telemetry_heartbeat: [], watches: [],
  });
  const s = dashStore(mkDb(f));
  assert.deepStrictEqual(await s.addFence('t1', { target: 'campaign:11', summary_text: 'Leave "Brand - Dubai" alone' }), { ok: true });
  const ins = f.calls.find((c) => c.method === 'POST' && /standing_exceptions/.test(c.url)).body[0];
  assert.deepStrictEqual([ins.change_key, ins.target, ins.created_from], ['fence:campaign:11', 'campaign:11', 'ui']);
  assert.deepStrictEqual(await s.addFence('t1', { target: 'drop table', summary_text: 'x' }), { ok: false, error: 'Nothing to fence.' });
  const opts = await s.fenceOptions('t1');
  assert.deepStrictEqual(opts, [{ target: 'campaign:11', name: 'Brand - Dubai', status: 'enabled', budget_daily_usd: 30, fenced: false }]);
  await s.retryChange('t1', 'c9');
  const retry = f.calls.find((c) => c.method === 'PATCH' && /changes\?id=eq\.c9/.test(c.url));
  assert.match(retry.url, /status=eq\.failed/);
  assert.strictEqual(retry.body.status, 'approved');
  const p = await s.revertPreview('t1', 'c5');
  assert.deepStrictEqual(p, { summary_text: 'Lowered the budget', then_line: 'Puts it back to: Runs on $25 a day', now_line: 'It runs on $30 a day today, which is not what we set.', can_undo: true });
  const r = await s.receipts('t1', new Date('2026-09-12T12:00:00Z'));
  assert.strictEqual(r.by_change.c9.state, 'failed');
});

test('fix plan push 5: refunded fee relocks, undo grace after cancel, pause with a date, the band sets itself, the $20 tail', async () => {
  const { accessFrom } = require('../../billing/src/access');
  const now = Date.parse('2026-09-12T12:00:00Z');
  assert.strictEqual(accessFrom({ paid: { kind: 'audit_unlock', refunded_at: '2026-09-10T00:00:00Z' }, sub: null, tenant: null, pricing: null, report: null, pending: [], ads: null, now }).level, 'locked', 'a refunded fee does not unlock');
  const canceled = accessFrom({ paid: { kind: 'audit_unlock' }, sub: { tier: 'core', status: 'canceled', canceled_at: '2026-09-01T00:00:00Z' }, tenant: { paused_until: '2026-10-01T00:00:00Z' }, pricing: null, report: null, pending: [], ads: null, now });
  assert.strictEqual(canceled.level, 'unlocked');
  assert.strictEqual(canceled.undo_until, '2026-10-01T00:00:00.000Z');
  assert.strictEqual(canceled.paused_until, '2026-10-01T00:00:00Z');
  assert.strictEqual(accessFrom({ paid: null, sub: { tier: 'core', status: 'canceled', canceled_at: '2026-07-01T00:00:00Z' }, tenant: null, pricing: null, report: null, pending: [], ads: null, now }).undo_until, null, 'grace is 30 days');

  const { dashStore, workerStore, opsStore } = require('../src/stores');
  const f = routedFetch({ tenants: [{ size_band: '4k' }], subscriptions: [{ stripe_subscription_id: 'sub_1' }], ledger: [], reports: [] });
  const d = dashStore(mkDb(f));
  assert.deepStrictEqual(await d.pauseTenant('t1', '2020-01-01T00:00:00Z'), { ok: false, error: 'Pick a date between tomorrow and 90 days from now.' });
  const untilIso = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const p = await d.pauseTenant('t1', untilIso);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.stripe_subscription_id, 'sub_1');
  const patch = f.calls.find((c) => c.method === 'PATCH' && /tenants\?id=eq\.t1/.test(c.url));
  assert.strictEqual(patch.body.status, 'paused');
  assert.strictEqual((await d.resumeTenant('t1')).ok, true);

  const w = workerStore(mkDb(f));
  assert.strictEqual(await w.setSizeBand('t1', '10k'), true);
  assert.strictEqual(await w.setSizeBand('t1', 'huge'), false);

  const ops = opsStore(mkDb(routedFetch({ subscriptions: [], reports: [{ created_at: '2026-09-06T03:00:00Z' }, { created_at: '2026-08-30T03:00:00Z' }, { created_at: '2026-08-23T03:00:00Z' }, { created_at: '2026-08-16T03:00:00Z' }] })));
  assert.deepStrictEqual(await ops.weeklyCadence('t1', Date.parse('2026-09-13T12:00:00Z')), { cadence: 'monthly', due: false });
  assert.deepStrictEqual(await ops.weeklyCadence('t1', Date.parse('2026-10-11T12:00:00Z')), { cadence: 'monthly', due: true });
  const fresh = opsStore(mkDb(routedFetch({ subscriptions: [], reports: [{ created_at: '2026-09-06T03:00:00Z' }] })));
  assert.deepStrictEqual(await fresh.weeklyCadence('t1', Date.parse('2026-09-13T12:00:00Z')), { cadence: 'weekly', due: true });
});

test('fix plan move 12 and 15: invite a viewer, approve a join, add a business, and the ops buttons', async () => {
  const { dashStore, opsStore } = require('../src/stores');
  const f = routedFetch({
    users: (url, init) => (init.method === 'POST' ? [{ id: 'u-new' }] : /role=eq\.owner/.test(url) ? [{ id: 'u1', email: 'owner@glow.ae', name: 'Max', google_sub: 'sub1' }] : /id=eq\.u9/.test(url) ? [{ id: 'u9', tenant_id: 't9', email: 'friend@glow.ae' }] : [{ id: 'u1', google_sub: 'sub1', email: 'owner@glow.ae', name: 'Max' }]),
    tenants: (url, init) => (init.method === 'POST' ? [{ id: 't-new' }] : [{ business_name: 'Glow Studio', website_url: 'glowstudio.ae' }]),
    google_connections: [{ refresh_token: 'rt', granted_scopes: [], scope_level: 'readonly', status: 'valid' }],
    magic_links: [], emails: [], ledger: [], assets: [], platform_notices: [],
  });
  const d = dashStore(mkDb(f));
  assert.deepStrictEqual(await d.inviteViewer('t1', 'not an email'), { ok: false, error: 'That does not look like an email address.' });
  assert.deepStrictEqual(await d.inviteViewer('t1', 'Friend@Glow.ae', { baseUrl: 'https://app', now: 1000 }), { ok: true });
  const invite = f.calls.find((c) => c.method === 'POST' && /emails/.test(c.url)).body[0];
  assert.strictEqual(invite.template_id, 'viewer_invite');
  assert.strictEqual(invite.to_email, 'friend@glow.ae');
  assert.match(invite.payload.join_url, /^https:\/\/app\/m\//);
  const link = f.calls.find((c) => c.method === 'POST' && /magic_links/.test(c.url)).body[0];
  assert.strictEqual(link.purpose, 'join_viewer');

  assert.deepStrictEqual(await d.approveJoin('t1', 'u9'), { ok: true, email: 'friend@glow.ae' });
  const moved = f.calls.find((c) => c.method === 'PATCH' && /users\?id=eq\.u9/.test(c.url));
  assert.deepStrictEqual(moved.body, { tenant_id: 't1', role: 'viewer' });

  const added = await d.addBusiness('t1', 'https://www.Second.ae/about');
  assert.deepStrictEqual(added, { ok: true, tenant_id: 't-new' });
  const newTenant = f.calls.find((c) => c.method === 'POST' && /tenants/.test(c.url)).body[0];
  assert.strictEqual(newTenant.website_url, 'www.second.ae');
  const conn = f.calls.find((c) => c.method === 'POST' && /google_connections/.test(c.url)).body[0];
  assert.strictEqual(conn.refresh_token, 'rt', 'the same Google connection serves the new business');
  assert.deepStrictEqual(await d.addBusiness('t1', 'nope'), { ok: false, error: 'That does not look like a website address.' });

  const ops = opsStore(mkDb(f));
  await ops.deleteTenant('t-gone');
  const rpc = f.calls.find((c) => /rpc\/delete_tenant/.test(c.url));
  assert.deepStrictEqual(rpc.body, { p_tenant: 't-gone' });
  assert.deepStrictEqual(await ops.setNotice('  Google is slow this morning; checks may land late.  '), { ok: true, text: 'Google is slow this morning; checks may land late.' });
  assert.deepStrictEqual(await ops.mergeTenants('a', 'a'), { ok: false });
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
    subscriptions: [{ tier: 'autopilot', status: 'active' }],
  });
  const st = await workerStore(mkDb(f)).draftState('t1');
  assert.deepStrictEqual(st.autopilot, { negatives: true, budgets: false, counting: true });
  assert.ok(st.exceptions.has('ex1') && st.inflight.has('campaign:1:budget') && st.recent.has('r1'));
  assert.deepStrictEqual({ d: st.bounds.weekly_budget_delta_pct, rv: st.bounds.reverted_30d, tot: st.bounds.account.daily_budget_total_usd }, { d: 10, rv: 2, tot: 20 });
  assert.strictEqual(st.bounds.campaign('2').budget_daily_usd, 10);
});

test('workerStore.draftState: autopilot consent only counts on an active Autopilot or Scale plan (gated platform)', async () => {
  const base = { autopilot_settings: [{ categories: { negatives: true, budgets: true, counting: true } }], standing_exceptions: [], changes: [], campaigns: [] };
  const none = await workerStore(mkDb(routedFetch({ ...base, subscriptions: [] }))).draftState('t1');
  assert.deepStrictEqual(none.autopilot, { negatives: false, budgets: false, counting: false });
  const core = await workerStore(mkDb(routedFetch({ ...base, subscriptions: [{ tier: 'core', status: 'active' }] }))).draftState('t1');
  assert.deepStrictEqual(core.autopilot, { negatives: false, budgets: false, counting: false });
  const lapsed = await workerStore(mkDb(routedFetch({ ...base, subscriptions: [{ tier: 'autopilot', status: 'canceled' }] }))).draftState('t1');
  assert.deepStrictEqual(lapsed.autopilot, { negatives: false, budgets: false, counting: false });
  const scale = await workerStore(mkDb(routedFetch({ ...base, subscriptions: [{ tier: 'scale', status: 'past_due' }] }))).draftState('t1');
  assert.deepStrictEqual(scale.autopilot, { negatives: true, budgets: true, counting: true });
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
