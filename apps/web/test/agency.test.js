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
    accountsList: async () => [{ id: 'a1', display_name: 'Glow Studio', status: 'active' }, { id: 'a2', display_name: 'New Client', status: 'pending' }],
    addAccount: async (ag, seat, { display_name }) => { actions.push(['acc_add', display_name]); return { id: 'a9', display_name, status: 'pending' }; },
    setAccountStatus: async (ag, seat, id, status) => actions.push(['acc_status', id, status]),
    billing: async () => ({ accounts: 2, rate: 45, band: '1–10', accountsSum: 90, platformFee: 249, total: 339, tier: 'mid', cycle: { daysRemaining: 16, daysInPeriod: 31 }, add_today_prorated: 23.23 }),
    campaignsFor: async () => [{ account_id: 'a1', account: 'Glow Studio', google_campaign_id: '21436587', name: 'Gel & Extensions', status: 'enabled' }],
    pacing: async () => [{ account_id: 'a1', account: 'Glow Studio', targets: { monthly_budget_usd: 2000 }, pacing: { status: 'over', deltaPct: 14.2, mtd: 1510, projected: 2284 }, performance: { status: 'hitting', cpa: 41.2, cpaTargetUsd: 45 } }],
    setTargets: async (ag, seat, accountId, patch) => { actions.push(['targets', accountId, patch.monthly_budget_usd]); return accountId === 'a-missing' ? null : { tenant_id: 't1' }; },
    alertsFor: async () => [{ id: 'al1', account: 'Glow Studio', severity: 'critical', kind: 'spend_spike', title: 'Spend 2.4× daily average', acked_at: null }],
    ackAlert: async (ag, seat, id) => actions.push(['ack', ag, seat, id]),
    snoozeChange: async (ag, seat, id, days, reason) => { actions.push(['snooze', id, days, reason]); return { until: '2026-08-27T00:00:00Z' }; },
    approveBatch: async (ag, seat, ids) => { ids.forEach((id) => actions.push(['approve', ag, seat, id])); return { approved: ids.length }; },
    draftsFor: async () => [{ id: 'd1', account: 'Glow Studio', template: 'brand', status: 'draft', spec: { name: 'Brand — Glow Studio' } }],
    createDraft: async (ag, seat, { account_id, template }) => {
      if (account_id === 'a-missing') return null;
      actions.push(['draft_new', account_id, template]);
      return { id: 'd9', account_id, template, status: 'draft', spec: { name: 'Brand — Glow Studio', settings: { start_paused: true } } };
    },
    draftAction: async (ag, seat, id, action) => {
      if (id === 'd-missing') return null;
      if (id === 'd-enabled' && action === 'approve') return { error: 'Cannot approve a enabled draft.' };
      actions.push(['draft', id, action]);
      return { status: action === 'approve' ? 'created_paused' : action === 'enable' ? 'enabled' : 'dismissed' };
    },
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

test('agency: account lifecycle — reads for all, add/pause/resume/remove admin-only, billing estimate', async () => {
  const ags = fakeAgencyStore();
  await withApp({ store: baseStore(), crawler: okCrawler, agencyStore: ags, sessionSecret: SECRET }, async (base) => {
    const post = (tenant, path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { cookie: cookie(tenant), 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });

    const list = await (await fetch(`${base}/api/agency/accounts`, { headers: { cookie: cookie('tn-am') } })).json();
    assert.strictEqual(list.accounts.length, 2);

    const bill = await (await fetch(`${base}/api/agency/billing`, { headers: { cookie: cookie('tn-ro') } })).json();
    assert.strictEqual(bill.total, 339);
    assert.strictEqual(bill.add_today_prorated, 23.23);

    const camps = await (await fetch(`${base}/api/agency/campaigns`, { headers: { cookie: cookie('tn-am') } })).json();
    assert.strictEqual(camps.campaigns[0].google_campaign_id, '21436587');

    // AM cannot manage the roster; admin can.
    assert.strictEqual((await post('tn-am', '/api/agency/accounts', { display_name: 'X' })).status, 403);
    assert.strictEqual((await post('tn-admin', '/api/agency/accounts', {})).status, 400);
    const add = await post('tn-admin', '/api/agency/accounts', { display_name: 'Harbor Clinic' });
    assert.strictEqual(add.status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['acc_add', 'Harbor Clinic']);

    assert.strictEqual((await post('tn-admin', '/api/agency/accounts/a1/pause')).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['acc_status', 'a1', 'paused']);
    assert.strictEqual((await post('tn-admin', '/api/agency/accounts/a1/resume')).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['acc_status', 'a1', 'active']);
    assert.strictEqual((await post('tn-admin', '/api/agency/accounts/a1/remove')).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['acc_status', 'a1', 'removed']);
    assert.strictEqual((await post('tn-am', '/api/agency/accounts/a1/pause')).status, 403);
  });
});

test('agency: P0s — pacing/alerts reads, targets + snooze + ack writes, batch approve logs each id', async () => {
  const ags = fakeAgencyStore();
  await withApp({ store: baseStore(), crawler: okCrawler, agencyStore: ags, sessionSecret: SECRET }, async (base) => {
    const post = (tenant, path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { cookie: cookie(tenant), 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });

    const pac = await (await fetch(`${base}/api/agency/pacing`, { headers: { cookie: cookie('tn-ro') } })).json();
    assert.strictEqual(pac.accounts[0].pacing.status, 'over');
    const al = await (await fetch(`${base}/api/agency/alerts`, { headers: { cookie: cookie('tn-ro') } })).json();
    assert.strictEqual(al.alerts[0].kind, 'spend_spike');

    // Writes gated: readonly blocked everywhere.
    assert.strictEqual((await post('tn-ro', '/api/agency/targets/a1', { monthly_budget_usd: 2500 })).status, 403);
    assert.strictEqual((await post('tn-ro', '/api/agency/approve-batch', { ids: ['x'] })).status, 403);

    assert.strictEqual((await post('tn-am', '/api/agency/targets/a1', { monthly_budget_usd: 2500 })).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['targets', 'a1', 2500]);
    assert.strictEqual((await post('tn-am', '/api/agency/targets/a-missing', { monthly_budget_usd: 1 })).status, 404);

    const sn = await post('tn-am', '/api/agency/snooze/chg1', { days: 7, reason: 'client OOO' });
    assert.strictEqual((await sn.json()).until, '2026-08-27T00:00:00Z');
    assert.deepStrictEqual(ags.actions.at(-1), ['snooze', 'chg1', 7, 'client OOO']);

    assert.strictEqual((await post('tn-am', '/api/agency/alerts/al1/ack')).status, 200);
    assert.deepStrictEqual(ags.actions.at(-1), ['ack', 'ag1', 's2', 'al1']);

    // Batch approve: one call, every id individually in the audit trail.
    assert.strictEqual((await post('tn-admin', '/api/agency/approve-batch', {})).status, 400);
    const batch = await post('tn-am', '/api/agency/approve-batch', { ids: ['chg1', 'chg2', 'chg3'] });
    assert.strictEqual((await batch.json()).approved, 3);
    assert.deepStrictEqual(ags.actions.slice(-3).map((a) => a[3]), ['chg1', 'chg2', 'chg3']);
  });
});

test('agency: campaign drafts — create/approve(paused)/enable are separate explicit actions', async () => {
  const ags = fakeAgencyStore();
  await withApp({ store: baseStore(), crawler: okCrawler, agencyStore: ags, sessionSecret: SECRET }, async (base) => {
    const post = (tenant, path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { cookie: cookie(tenant), 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });

    const list = await (await fetch(`${base}/api/agency/drafts`, { headers: { cookie: cookie('tn-ro') } })).json();
    assert.strictEqual(list.drafts[0].template, 'brand');

    // readonly cannot create; am can; unknown account 404s; missing fields 400.
    assert.strictEqual((await post('tn-ro', '/api/agency/drafts', { account_id: 'a1', template: 'brand' })).status, 403);
    assert.strictEqual((await post('tn-am', '/api/agency/drafts', {})).status, 400);
    assert.strictEqual((await post('tn-am', '/api/agency/drafts', { account_id: 'a-missing', template: 'brand' })).status, 404);
    const created = await post('tn-am', '/api/agency/drafts', { account_id: 'a1', template: 'brand' });
    assert.strictEqual(created.status, 200);
    assert.strictEqual((await created.json()).draft.spec.settings.start_paused, true);
    assert.deepStrictEqual(ags.actions.at(-1), ['draft_new', 'a1', 'brand']);

    // approve → created_paused; enable is its own second click; bad transitions 409.
    const ap = await post('tn-am', '/api/agency/drafts/d1/approve');
    assert.strictEqual((await ap.json()).status, 'created_paused');
    const en = await post('tn-am', '/api/agency/drafts/d1/enable');
    assert.strictEqual((await en.json()).status, 'enabled');
    assert.strictEqual((await post('tn-am', '/api/agency/drafts/d-missing/approve')).status, 404);
    assert.strictEqual((await post('tn-am', '/api/agency/drafts/d-enabled/approve')).status, 409);
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
