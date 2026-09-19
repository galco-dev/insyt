const assert = require('node:assert');
const { test } = require('node:test');
const { createApp } = require('../src/server');
const { issueSession, cookieFor } = require('../src/session');
const { mintLink } = require('../../../packages/emails/src/magic-links');

const okCrawler = { discoveryCrawl: async () => ({ status: 'complete', tags_found: {} }) };

function linkStore() {
  const rows = []; let id = 1;
  return {
    insertLink: (r) => rows.push({ id: id++, ...r }),
    findByHash: (h) => rows.find((r) => r.token_hash === h) || null,
    markUsed: (rid, at) => { rows.find((r) => r.id === rid).used_at = at; },
  };
}

const baseStore = () => ({
  createCrawl: () => '1', getCrawl: () => null, patchCrawl: () => {}, crawlCountForDomain: () => 0,
  getReportHtml: () => null, magicLinks: linkStore(),
});

const dashStore = () => {
  const actions = [];
  return {
    actions,
    healthLatest: async () => ({ score: 82, trend: [] }),
    pendingApprovals: async () => [{ id: 'ch1', title: '43 search terms are wasting money', money_line: 'about $340 a month' }],
    cumulative: async () => ({ fixes: 12, waste_removed_usd: 480 }),
    reports: async () => [{ id: 'rep1', type: 'weekly', created_at: '2026-08-16T00:00:00Z', viewed_at: null }],
    ledger: async () => [{ summary_text: 'Added 43 negative keywords', created_at: '2026-08-10T00:00:00Z', money_impact_usd: 340, event: 'fix_applied', change_id: 'ch0' }],
    settings: async () => ({ plan_line: 'Core · $129/mo', autopilot: { negatives: 'manual' }, connection_status: 'Google connection healthy.' }),
    discovery: async () => ({ matched: [{ display_name: 'JobPeak Ads', external_id: '642' }], unmatched: [] }),
    planOptions: async () => ({ band: '4k', tiers: [{ tier: 'core', label: 'Core', price_usd: 129, selected: true }] }),
    firstFix: async () => null,
    journey: async () => ({ journey: 'B', stage: 'tag_install', gates: { tag: false, billing: false, approval: true }, instruction_line: 'Install your tracking — the guide takes 30 seconds.' }),
    approveChange: async (t, id) => actions.push(['approve', id]),
    dismissChange: async (t, id) => actions.push(['dismiss', id]),
    requestRevert: async (t, id) => actions.push(['revert', id]),
    confirmAssets: async () => actions.push(['confirm']),
  };
};

async function withApp(deps, fn) {
  const app = createApp(deps);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { app.close(); }
}

const SECRET = 'test-secret';
const authedCookie = () => cookieFor(issueSession({ tenantId: 'tn1', secret: SECRET, now: Date.now() })).split(';')[0];

test('dashboard: unauthenticated /app redirects to landing; session cookie unlocks screens', async () => {
  const ds = dashStore();
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const anon = await fetch(`${base}/app`, { redirect: 'manual' });
    assert.strictEqual(anon.status, 302);
    const home = await (await fetch(`${base}/app`, { headers: { cookie: authedCookie() } })).text();
    assert.ok(home.includes('82'), 'health score renders');
    assert.ok(home.includes('waiting for your approval'));
    const approvals = await (await fetch(`${base}/app/approvals`, { headers: { cookie: authedCookie() } })).text();
    assert.ok(approvals.includes('43 search terms'));
    const post = await fetch(`${base}/app/approve/ch1`, { method: 'POST', headers: { cookie: authedCookie() }, redirect: 'manual' });
    assert.strictEqual(post.status, 302);
    assert.deepStrictEqual(ds.actions, [['approve', 'ch1']]);
  });
});

test('api: /api/app/overview rides the session, carries access, and is null on a store without it', async () => {
  const ds = dashStore();
  ds.access = async () => ({ level: 'unlocked', pending_count: 2, pending_value_usd: 340 });
  ds.overview = async (t, now) => ({ tenant: t, spend: null, this_week: { next_check_days: now instanceof Date ? 3 : -1 }, accounts: [] });
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const anon = await fetch(`${base}/api/app/overview`);
    assert.strictEqual(anon.status, 401);
    const r = await fetch(`${base}/api/app/overview`, { headers: { cookie: authedCookie() } });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.overview.tenant, 'tn1');
    assert.strictEqual(body.overview.this_week.next_check_days, 3, 'the server clock is passed as a Date');
    assert.strictEqual(body.access.level, 'unlocked');
  });
  const older = dashStore();
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: older, sessionSecret: SECRET }, async (base) => {
    const body = await (await fetch(`${base}/api/app/overview`, { headers: { cookie: authedCookie() } })).json();
    assert.strictEqual(body.overview, null);
  });
});

test('api: /api/app/approve-batch needs a plan, then approves each id through the store', async () => {
  const gated = dashStore();
  gated.access = async () => ({ level: 'unlocked' });
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: gated, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/approve-batch`, { method: 'POST', headers: { cookie: authedCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['c1', 'c2'] }) });
    assert.strictEqual(r.status, 402);
    assert.strictEqual((await r.json()).plan_required, true);
    assert.deepStrictEqual(gated.actions, [], 'nothing approved below a plan');
  });
  const active = dashStore();
  active.access = async () => ({ level: 'active' });
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: active, sessionSecret: SECRET }, async (base) => {
    const empty = await fetch(`${base}/api/app/approve-batch`, { method: 'POST', headers: { cookie: authedCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ ids: [] }) });
    assert.strictEqual(empty.status, 400);
    const r = await fetch(`${base}/api/app/approve-batch`, { method: 'POST', headers: { cookie: authedCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['c1', 'c2'] }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, approved: 2, requested: 2, first_approval: false });
    assert.deepStrictEqual(active.actions, [['approve', 'c1'], ['approve', 'c2']]);
  });
});

test('api: ledger and report carry receipts when the store has them', async () => {
  const ds = dashStore();
  ds.receipts = async () => ({ by_change: { ch0: { state: 'verified', line: 'held' } }, by_finding: { f1: { state: 'watching' } } });
  ds.reportData = async () => ({ id: 'rep1', type: 'weekly', created_at: '2026-08-16T00:00:00Z', findings_snapshot: [], unlocked: true, summary: {} });
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const led = await (await fetch(`${base}/api/app/ledger`, { headers: { cookie: authedCookie() } })).json();
    assert.deepStrictEqual(led.receipts, { ch0: { state: 'verified', line: 'held' } });
    const rep = await (await fetch(`${base}/api/app/report/rep1`, { headers: { cookie: authedCookie() } })).json();
    assert.deepStrictEqual(rep.receipts, { f1: { state: 'watching' } });
  });
  const older = dashStore();
  older.reportData = ds.reportData;
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: older, sessionSecret: SECRET }, async (base) => {
    const led = await (await fetch(`${base}/api/app/ledger`, { headers: { cookie: authedCookie() } })).json();
    assert.deepStrictEqual(led.receipts, {});
  });
});

test('api: settings writes (business, emails), the runs list, and the unsubscribe link flip the same flag', async () => {
  const ds = dashStore();
  const writes = [];
  ds.setBusiness = async (t, b) => { writes.push(['business', t, b]); return { ok: true, business_name: b.name }; };
  ds.setEmailReports = async (t, on) => { writes.push(['emails', t, on]); return { ok: true, reports: on }; };
  ds.runs = async () => [{ id: 'r1', type: 'weekly', status: 'complete' }];
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const h = { cookie: authedCookie(), 'content-type': 'application/json' };
    const b = await fetch(`${base}/api/app/business`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'JobPeak', timezone: 'Asia/Dubai' }) });
    assert.strictEqual(b.status, 200);
    const e = await fetch(`${base}/api/app/emails`, { method: 'POST', headers: h, body: JSON.stringify({ reports: false }) });
    assert.deepStrictEqual(await e.json(), { ok: true, reports: false });
    const runs = await (await fetch(`${base}/api/app/runs`, { headers: h })).json();
    assert.strictEqual(runs.runs.length, 1);
    const anon = await fetch(`${base}/api/app/business`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(anon.status, 401);
    const unsub = await fetch(`${base}/m/unsubscribe?t=6f1c1c2e-0000-4000-8000-000000000001`);
    assert.strictEqual(unsub.status, 200);
    assert.deepStrictEqual(writes, [
      ['business', 'tn1', { name: 'JobPeak', website: undefined, timezone: 'Asia/Dubai' }],
      ['emails', 'tn1', false],
      ['emails', '6f1c1c2e-0000-4000-8000-000000000001', false],
    ]);
  });
});

test('api: POST /api/app/alerts/:id/ack is free at every level and tenant-scoped through the store', async () => {
  const ds = dashStore();
  ds.access = async () => ({ level: 'locked' });
  const acks = [];
  ds.ackAlert = async (t, id) => { acks.push([t, id]); return { ok: true }; };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/alerts/al1/ack`, { method: 'POST', headers: { cookie: authedCookie() } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(acks, [['tn1', 'al1']]);
  });
});

test('api: POST /api/app/confirm passes the chosen accounts and fences to the store', async () => {
  const ds = dashStore();
  const seen = [];
  ds.confirmAssets = async (t, choices) => { seen.push([t, choices]); };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/confirm`, { method: 'POST', headers: { cookie: authedCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ link: ['ad1'], exceptions: [{ target: 'campaign:7', summary_text: 'Leave Brand alone' }] }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(seen, [['tn1', { link: ['ad1'], exceptions: [{ target: 'campaign:7', summary_text: 'Leave Brand alone' }] }]]);
    const bare = await fetch(`${base}/api/app/confirm`, { method: 'POST', headers: { cookie: authedCookie() } });
    assert.strictEqual(bare.status, 200, 'no body still confirms, as the old client did');
    assert.deepStrictEqual(seen[1][1], { link: [], exceptions: [] });
  });
});

test('api (fix plan push 4): later is free, partial yes and retry need a plan, a fence writes through the store', async () => {
  const ds = dashStore();
  const seen = [];
  ds.access = async () => ({ level: 'unlocked' });
  ds.snoozeChange = async (t, id, days) => { seen.push(['snooze', id, days]); return { ok: true, until: 'x' }; };
  ds.addFence = async (t, b) => { seen.push(['fence', b]); return { ok: true }; };
  ds.retryChange = async (t, id) => { seen.push(['retry', id]); return { ok: true }; };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const h = { cookie: authedCookie(), 'content-type': 'application/json' };
    assert.strictEqual((await fetch(`${base}/api/app/snooze/c1`, { method: 'POST', headers: h, body: JSON.stringify({ days: 7 }) })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/app/approve-part/c1`, { method: 'POST', headers: h, body: JSON.stringify({ keep: ['a'] }) })).status, 402);
    assert.strictEqual((await fetch(`${base}/api/app/retry/c1`, { method: 'POST', headers: h })).status, 402);
    assert.strictEqual((await fetch(`${base}/api/app/exceptions`, { method: 'POST', headers: h, body: JSON.stringify({ target: 'campaign:11', summary_text: 'Leave "Brand" alone', change_id: 'c1' }) })).status, 200);
    assert.deepStrictEqual(seen, [['snooze', 'c1', 7], ['fence', { target: 'campaign:11', summary_text: 'Leave "Brand" alone', change_id: 'c1' }]]);
  });
});

test('api (fix plan push 5): pause validates the date and pauses Stripe, undo is free inside the grace, look again needs the dep', async () => {
  const ds = dashStore();
  const calls = [];
  ds.access = async () => ({ level: 'unlocked', undo_until: new Date(Date.now() + 86_400_000).toISOString() });
  ds.pauseTenant = async (t, until) => (until ? { ok: true, paused_until: until, stripe_subscription_id: 'sub_1' } : { ok: false, error: 'Pick a date.' });
  const checkout = { pause: async (id, until) => calls.push(['pause', id, until]), resume: async (id) => calls.push(['resume', id]) };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET, checkout }, async (base) => {
    const h = { cookie: authedCookie(), 'content-type': 'application/json' };
    assert.strictEqual((await fetch(`${base}/api/app/pause`, { method: 'POST', headers: h, body: '{}' })).status, 400);
    const ok = await fetch(`${base}/api/app/pause`, { method: 'POST', headers: h, body: JSON.stringify({ until: '2026-10-12T00:00:00Z' }) });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(calls, [['pause', 'sub_1', '2026-10-12T00:00:00Z']]);
    const undo = await fetch(`${base}/api/app/revert/c1`, { method: 'POST', headers: h });
    assert.strictEqual(undo.status, 200, 'undo is free inside the 30-day grace');
    assert.deepStrictEqual(ds.actions, [['revert', 'c1']]);
    assert.strictEqual((await fetch(`${base}/api/app/rediscover`, { method: 'POST', headers: h })).status, 501);
  });
});

test('api (fix plan move 12): a viewer reads everything and changes nothing; access says the role', async () => {
  const ds = dashStore();
  ds.access = async () => ({ level: 'active' });
  const viewerCookie = cookieFor(issueSession({ tenantId: 'tn1', secret: SECRET, now: Date.now(), role: 'viewer' })).split(';')[0];
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const acc = await (await fetch(`${base}/api/app/access`, { headers: { cookie: viewerCookie } })).json();
    assert.strictEqual(acc.access.role, 'viewer');
    const home = await fetch(`${base}/api/app/home`, { headers: { cookie: viewerCookie } });
    assert.strictEqual(home.status, 200, 'reads are open');
    const write = await fetch(`${base}/api/app/approve/ch1`, { method: 'POST', headers: { cookie: viewerCookie } });
    assert.strictEqual(write.status, 403);
    assert.strictEqual((await write.json()).view_only, true);
    assert.deepStrictEqual(ds.actions, [], 'nothing approved');
    const owner = await (await fetch(`${base}/api/app/access`, { headers: { cookie: authedCookie() } })).json();
    assert.strictEqual(owner.access.role, 'owner');
  });
});

test('dashboard: forged session cookie is rejected', async () => {
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: dashStore(), sessionSecret: SECRET }, async (base) => {
    const forged = `insyt_s=tn1.${Date.now() + 9e6}.deadbeef`;
    const r = await fetch(`${base}/app`, { headers: { cookie: forged }, redirect: 'manual' });
    assert.strictEqual(r.status, 302, 'bounced to landing');
  });
});

test('magic link redemption signs in and routes by purpose', async () => {
  const store = baseStore();
  const { token } = mintLink({ tenantId: 'tn1', purpose: 'approve_all', targetId: null, baseUrl: 'x', now: Date.now() }, store.magicLinks);
  await withApp({ store, crawler: okCrawler, dashStore: dashStore(), sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/m/${token}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/app/approvals');
    const cookie = r.headers.get('set-cookie');
    assert.ok(cookie && cookie.includes('insyt_s='), 'session cookie set on redemption');
    const home = await fetch(`${base}/app`, { headers: { cookie: cookie.split(';')[0] } });
    assert.strictEqual(home.status, 200, 'redeemed link session works on the dashboard');
  });
});

test('screens render: settings, discovery confirm, plan, journey, ledger, reports', async () => {
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: dashStore(), sessionSecret: SECRET }, async (base) => {
    const get = async (p) => (await fetch(`${base}${p}`, { headers: { cookie: authedCookie() } })).text();
    assert.ok((await get('/app/settings')).includes('Core · $129/mo'));
    assert.ok((await get('/app/confirm')).includes('JobPeak Ads'));
    assert.ok((await get('/app/plan')).includes('$129/mo'));
    assert.ok((await get('/app/journey')).includes('Install your tracking'));
    assert.ok((await get('/app/ledger')).includes('negative keywords'));
    assert.ok((await get('/app/reports')).includes('weekly report'));
    assert.ok((await get('/app/first-fix')).includes('full picture'), 'empty state sells next action');
  });
});

test('ops console: token required, tenants table renders, manual run enqueues', async () => {
  const enqueued = [];
  const opsStore = {
    tenants: async () => [{ id: 'tn1', business_name: 'The Nail DXB', status: 'active' }],
    subscriptions: async () => [{ tenant_id: 'tn1', tier: 'core', size_band: '4k', price_usd: 129, status: 'active' }],
    cogsByTenant: async () => [{ tenant_id: 'tn1', sum: 8.4 }],
    recentRuns: async () => [],
    ledgerFor: async () => [],
    enqueueRun: async (row) => ({ id: 'r9', ...row }),
  };
  await withApp({ store: baseStore(), crawler: okCrawler, opsStore, queue: { enqueue: async (q, r) => enqueued.push(r.id) }, opsToken: 'sekret', sessionSecret: SECRET }, async (base) => {
    assert.strictEqual((await fetch(`${base}/ops`)).status, 401);
    const ok = await (await fetch(`${base}/ops`, { headers: { authorization: 'Bearer sekret' } })).text();
    assert.ok(ok.includes('The Nail DXB'));
    assert.ok(ok.includes('MRR $129'));
    const run = await fetch(`${base}/ops/run/tn1`, { method: 'POST', headers: { authorization: 'Bearer sekret' }, redirect: 'manual' });
    assert.strictEqual(run.status, 302);
    assert.deepStrictEqual(enqueued, ['r9']);
  });
});

test('agency plan move 11: a managed tenant in read-only mode is a viewer, its held report answers 404 with held', async () => {
  const ds = dashStore();
  ds.managed = async () => ({ agency_name: 'Northlight', client_mode: 'read_only' });
  ds.reportData = async (t, id) => (id === 'rep-h' ? { held: true } : null);
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/approve/ch1`, { method: 'POST', headers: { cookie: authedCookie() } });
    assert.strictEqual(r.status, 403);
    const body = await r.json();
    assert.strictEqual(body.view_only, true);
    assert.match(body.error, /^Northlight looks after approvals/);
    assert.ok(!ds.actions.some((a) => a[0] === 'approve'), 'nothing approved');
    const held = await fetch(`${base}/api/app/report/rep-h`, { headers: { cookie: authedCookie() } });
    assert.strictEqual(held.status, 404);
    assert.strictEqual((await held.json()).held, true);
    ds.managed = async () => ({ agency_name: 'Northlight', client_mode: 'shared' });
    assert.strictEqual((await fetch(`${base}/api/app/approve/ch1`, { method: 'POST', headers: { cookie: authedCookie() } })).status, 200, 'shared mode keeps the client\'s yes');
  });
});

test('the web report at /r/:id awaits the store: a real id renders, an unknown or malformed id is a 404', async () => {
  const store = { ...baseStore(), getReportHtml: async (id) => (id === '11111111-1111-1111-1111-111111111111' ? { html_web: '<h1>Report</h1>' } : null) };
  await withApp({ store, crawler: okCrawler, dashStore: dashStore(), sessionSecret: SECRET }, async (base) => {
    const ok = await fetch(`${base}/r/11111111-1111-1111-1111-111111111111`);
    assert.strictEqual(ok.status, 200);
    assert.match(await ok.text(), /<h1>Report<\/h1>/);
    assert.strictEqual((await fetch(`${base}/r/22222222-2222-2222-2222-222222222222`)).status, 404);
    assert.strictEqual((await fetch(`${base}/r/not-a-report`)).status, 404);
  });
});

test('api: a report id that is not an id answers 404, never 500 (a link with no target lands on the app)', async () => {
  const ds = dashStore();
  ds.reportData = async () => { throw new Error('postgrest 400: invalid input syntax for type uuid'); };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/report/null`, { headers: { cookie: authedCookie() } });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /not found/i);
  });
});

test('api: a signed-out telemetry event is dropped with 204, not answered with a sign-in error', async () => {
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: dashStore(), sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'gate.shown', props: {} }) });
    assert.equal(r.status, 204);
    const other = await fetch(`${base}/api/app/access`);
    assert.equal(other.status, 401);
  });
});

test('api: /api/app/first-ad answers from the store, and a draft approve says when it was the first yes', async () => {
  const ds = dashStore();
  ds.firstAd = async () => ({ business: 'Smile Dental', website: 'smile.com', trade: 'dentists', service: 'Dentist', launch: true, campaigns_count: 0, drafts_count: 0 });
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const r = await (await fetch(`${base}/api/app/first-ad`, { headers: { cookie: authedCookie() } })).json();
    assert.deepStrictEqual({ service: r.service, launch: r.launch, campaigns: r.campaigns_count }, { service: 'Dentist', launch: true, campaigns: 0 });
    const anon = await fetch(`${base}/api/app/first-ad`);
    assert.equal(anon.status, 401);
  });
});

test('api: tracking is read, started, handed off and checked through the store; a bad hand-off address is a 400', async () => {
  const ds = dashStore();
  const calls = [];
  ds.trackingState = async () => ({ started: true, platform: 'wix', gtm_id: 'GTM-1', verified_at: null });
  ds.startTracking = async (t) => { calls.push(['start', t]); return { started: true, platform: 'wix', gtm_id: 'GTM-1', already_started: false }; };
  ds.trackingHandoff = async (t, email) => (email && email.includes('@') ? { ok: true, sent_to: email } : { error: 'That does not look like an email address.' });
  ds.trackingCheckNow = async () => ({ ok: true });
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const h = { cookie: authedCookie(), 'content-type': 'application/json' };
    const st = await (await fetch(`${base}/api/app/tracking`, { headers: h })).json();
    assert.equal(st.platform, 'wix');
    const start = await (await fetch(`${base}/api/app/tracking/start`, { method: 'POST', headers: h, body: '{}' })).json();
    assert.deepStrictEqual({ ok: start.ok, gtm: start.gtm_id }, { ok: true, gtm: 'GTM-1' });
    assert.equal(calls.length, 1);
    const bad = await fetch(`${base}/api/app/tracking/handoff`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'nope' }) });
    assert.equal(bad.status, 400);
    const good = await (await fetch(`${base}/api/app/tracking/handoff`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'dev@example.com' }) })).json();
    assert.equal(good.sent_to, 'dev@example.com');
    const chk = await (await fetch(`${base}/api/app/tracking/check`, { method: 'POST', headers: h, body: '{}' })).json();
    assert.equal(chk.ok, true);
  });
});

test('api: discovery says whether we can create a Google Ads account, and the creation route answers from the store', async () => {
  const ds = dashStore();
  ds.discovery = async () => ({ matched: [], unmatched: [], doors: { ads_account: { state: 'unused', matched: [], candidates: [] }, ga4_property: { state: 'unused', matched: [], candidates: [] }, gtm_container: { state: 'unused', matched: [], candidates: [] } }, campaigns: [], site: 'smile.com', no_access: true });
  ds.adsAccountAvailable = () => true;
  const asked = [];
  ds.createAdsAccount = async (t, opts) => { asked.push(opts); return { ok: true, customer_id: '123-456-7890', invitation_link: 'https://ads.google.com/invite/x', currency: opts.currency }; };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const h = { cookie: authedCookie(), 'content-type': 'application/json' };
    const d = await (await fetch(`${base}/api/app/discovery`, { headers: h })).json();
    assert.equal(d.can_create_ads_account, true);
    const r = await (await fetch(`${base}/api/app/ads-account`, { method: 'POST', headers: h, body: JSON.stringify({ currency: 'gbp', time_zone: 'Europe/London' }) })).json();
    assert.deepStrictEqual({ ok: r.ok, id: r.customer_id }, { ok: true, id: '123-456-7890' });
    assert.deepStrictEqual(asked[0], { currency: 'GBP', time_zone: 'Europe/London' });
  });
  const off = dashStore();
  off.adsAccountAvailable = () => false;
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: off, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/app/ads-account`, { method: 'POST', headers: { cookie: authedCookie(), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 501);
  });
});

test('api: a draft refusal carries Google\'s billing page, and a Google permission refusal explains the invitation', async () => {
  const ds = dashStore();
  ds.draftAction = async (t, id, action) => {
    if (id === 'd-billing') return { error: 'Google needs a card for the clicks before this switches on.', steps: [], billing_url: 'https://ads.google.com/aw/billing/summary' };
    const e = new Error('google api 403: USER_PERMISSION_DENIED'); e.code = 'PERMISSION_DENIED'; throw e;
  };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const h = { cookie: authedCookie(), 'content-type': 'application/json' };
    const r = await fetch(`${base}/api/app/drafts/d-billing/enable`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).billing_url, /ads\.google\.com/);
    const p = await fetch(`${base}/api/app/drafts/d-new/approve`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(p.status, 409);
    assert.match((await p.json()).error, /accept the invitation/);
  });
});

test('api: /api/app/locations answers the place suggestions from the store', async () => {
  const ds = dashStore();
  ds.suggestLocations = async (t, q) => (q === 'Manch' ? [{ id: '1006886', name: 'Manchester', canonical_name: 'Manchester, England, United Kingdom', type: 'City', country: 'GB' }] : []);
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    const r = await (await fetch(`${base}/api/app/locations?q=Manch`, { headers: { cookie: authedCookie() } })).json();
    assert.equal(r.locations[0].id, '1006886');
    const none = await (await fetch(`${base}/api/app/locations?q=zz`, { headers: { cookie: authedCookie() } })).json();
    assert.deepStrictEqual(none.locations, []);
  });
});
