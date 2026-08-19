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
