// Agency console API (master §13): seat resolution, role gates, no-auto-apply
// action logging, review queue, brand kit versioning.
const assert = require('node:assert');
const { test } = require('node:test');
const { createApp } = require('../src/server');
const { issueSession, cookieFor } = require('../src/session');

const okCrawler = { discoveryCrawl: async () => ({ status: 'complete', tags_found: {} }) };
const baseStore = () => ({
  createCrawl: () => '1', getCrawl: () => null, patchCrawl: () => {}, crawlCountForDomain: () => 0,
  getReportHtml: () => null, magicLinks: { insertLink: () => {}, findByHash: () => null, markUsed: () => {} },
});

function fakeAgencyStore() {
  const actions = [];
  const seats = { 'tn-admin': { id: 's1', agency_id: 'ag1', role: 'admin', name: 'Ana', email: 'ana@x.com' },
    'tn-am': { id: 's2', agency_id: 'ag1', role: 'am', name: 'Mo', email: 'mo@x.com' },
    'tn-ro': { id: 's3', agency_id: 'ag1', role: 'readonly', name: 'Ro', email: 'ro@x.com' } };
  return {
    actions,
    seatByTenant: async (t) => seats[t] || null,
    agency: async () => ({ id: 'ag1', name: 'Northlight', platform_tier: 'mid' }),
    portfolio: async () => [{ id: 'a1', name: 'Glow Studio', health: 58, pending_changes: 3, critical: 2 }],
    triage: async () => [{ id: 'chg1', account: 'Glow Studio', title: 'Duplicate GA4 purchase tag', money_monthly_usd: 430 }],
    reviewQueue: async () => [{ id: 'rep1', account: 'Glow Studio', type: 'weekly' }],
    approveChange: async (ag, seat, id) => actions.push(['approve', ag, seat, id]),
    dismissChange: async (ag, seat, id, reason) => actions.push(['dismiss', ag, seat, id, reason]),
    approveReport: async (ag, seat, id) => actions.push(['report_ok', ag, seat, id]),
    rejectReport: async (ag, seat, id, reason) => actions.push(['report_no', ag, seat, id, reason]),
    brandKit: async () => ({ version: 2, display_name: 'Northlight' }),
    saveBrandKit: async (ag, seat, kit) => { actions.push(['brand', kit.display_name]); return { version: 3 }; },
    seats: async () => Object.values(seats),
    addSeat: async (ag, seat, s) => { actions.push(['seat_add', s.email]); return { id: 's9', ...s }; },
    updateSeat: async (ag, seat, target, patch) => actions.push(['seat_up', target, patch.role]),
    credits: async () => ({ balance: 4, events: [] }),
    auditLog: async () => [{ event: 'change_approved' }],
  };
}

async function withApp(deps, fn) {
  const app = createApp(deps);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { app.close(); }
}

const SECRET = 'test-secret';
const cookie = (tenantId) => cookieFor(issueSession({ tenantId, secret: SECRET, now: Date.now() })).split(';')[0];

test('agency: seat resolution gates access; no seat = 403; reads work', async () => {
  const ags = fakeAgencyStore();
  await withApp({ store: baseStore(), crawler: okCrawler, agencyStore: ags, sessionSecret: SECRET }, async (base) => {
    assert.strictEqual((await fetch(`${base}/api/agency/portfolio`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/agency/portfolio`, { headers: { cookie: cookie('tn-nobody') } })).status, 403);

    const p = await (await fetch(`${base}/api/agency/portfolio`, { headers: { cookie: cookie('tn-am') } })).json();
    assert.strictEqual(p.accounts[0].name, 'Glow Studio');
    const t = await (await fetch(`${base}/api/agency/triage`, { headers: { cookie: cookie('tn-ro') } })).json();
    assert.strictEqual(t.queue[0].money_monthly_usd, 430);
    const me = await (await fetch(`${base}/api/agency/me`, { headers: { cookie: cookie('tn-admin') } })).json();
    assert.strictEqual(me.agency.name, 'Northlight');
  });
});

test('agency: role gates — readonly cannot write, am can approve, admin manages seats', async () => {
  const ags = fakeAgencyStore();
  await withApp({ store: baseStore(), crawler: okCrawler, agencyStore: ags, sessionSecret: SECRET }, async (base) => {
    const post = (tenant, path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { cookie: cookie(tenant), 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });

    assert.strictEqual((await post('tn-ro', '/api/agency/approve/chg1')).status, 403);
    assert.strictEqual((await post('tn-am', '/api/agency/approve/chg1')).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['approve', 'ag1', 's2', 'chg1']);

    assert.strictEqual((await post('tn-am', '/api/agency/dismiss/chg2', { reason: 'client asked' })).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['dismiss', 'ag1', 's2', 'chg2', 'client asked']);

    assert.strictEqual((await post('tn-am', '/api/agency/report/rep1/approve')).status, 200);
    assert.strictEqual((await post('tn-am', '/api/agency/report/rep1/reject', { reason: 'wrong tone' })).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['report_no', 'ag1', 's2', 'rep1', 'wrong tone']);

    // seats: admin-only
    assert.strictEqual((await post('tn-am', '/api/agency/seats', { email: 'new@x.com' })).status, 403);
    const add = await post('tn-admin', '/api/agency/seats', { email: 'new@x.com', role: 'am' });
    assert.strictEqual(add.status, 200);
    assert.strictEqual((await post('tn-admin', '/api/agency/seats/s2', { role: 'admin' })).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['seat_up', 's2', 'admin']);
  });
});

test('agency: brand kit save returns new version; credits and log read', async () => {
  const ags = fakeAgencyStore();
  await withApp({ store: baseStore(), crawler: okCrawler, agencyStore: ags, sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/api/agency/brand`, {
      method: 'POST', headers: { cookie: cookie('tn-admin'), 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Northlight Digital' }),
    });
    assert.deepStrictEqual(await r.json(), { ok: true, version: 3 });
    const credits = await (await fetch(`${base}/api/agency/credits`, { headers: { cookie: cookie('tn-am') } })).json();
    assert.strictEqual(credits.balance, 4);
    const log = await (await fetch(`${base}/api/agency/log`, { headers: { cookie: cookie('tn-ro') } })).json();
    assert.strictEqual(log.entries[0].event, 'change_approved');
  });
});
