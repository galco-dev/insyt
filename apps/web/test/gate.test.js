// The gate (gated-platform spec): locked / unlocked / active, the 402 on every
// write that needs a plan, the free reads and dismissals at every level, the
// Checkout return path, and the webhook approving the tapped change.
const assert = require('node:assert');
const { test } = require('node:test');
const { createApp } = require('../src/server');
const { issueSession, cookieFor } = require('../src/session');
const { accessFrom, safeNext, autopilotAllowed } = require('../../../packages/billing/src/access');
const { handleWebhook } = require('../../../packages/billing/src/webhooks');

const okCrawler = { discoveryCrawl: async () => ({ status: 'complete', tags_found: {} }) };
const baseStore = () => ({
  createCrawl: () => '1', getCrawl: () => null, patchCrawl: () => {}, crawlCountForDomain: () => 0,
  getReportHtml: () => null, magicLinks: { insertLink: () => {}, findByHash: () => null, markUsed: () => {} },
});
const SECRET = 'test-secret';
const cookie = () => cookieFor(issueSession({ tenantId: 'tn1', secret: SECRET, now: Date.now() })).split(';')[0];

function dash(level) {
  const actions = [];
  const access = { level, paid: level !== 'locked', plan: level === 'active' ? { tier: 'core', status: 'active', label: 'Core', price_usd: 129 } : null, price_usd: 129, waste_monthly_usd: 740, pending_count: 1, pending_value_usd: 340, currency: 'USD', credit_applies: level === 'unlocked', has_report: true, band: '4k', prices: { core: 129, autopilot: 199, scale: 399 } };
  return {
    actions,
    access: async () => access,
    healthLatest: async () => ({ score: 61, trend: [] }),
    pendingApprovals: async () => [{ id: 'ch1', title: 'Exclude 43 search terms', money_line: 'about $340 a month', finding_id: 'f1' }],
    cumulative: async () => null,
    reports: async () => [{ id: 'rep1', type: 'signup', created_at: '2026-09-07T00:00:00Z', viewed_at: null }],
    reportData: async () => ({ id: 'rep1', type: 'signup', created_at: '2026-09-07T00:00:00Z', unlocked: level !== 'locked', summary: { waste_monthly_usd: 740 }, findings_snapshot: [] }),
    ledger: async () => [{ id: 'l1', summary_text: 'Excluded 43 search terms', created_at: '2026-09-07T00:00:00Z', event: 'fix_applied', change_id: 'ch0', actor: 'user' }],
    settings: async () => ({ plan_line: 'x', autopilot: {}, connection_status: 'Google connection healthy.' }),
    journey: async () => ({ journey: 'A', stage: 'active', gates: { tag: true, billing: true, approval: true }, instruction_line: '' }),
    approveChange: async (t, id) => actions.push(['approve', id]),
    dismissChange: async (t, id) => actions.push(['dismiss', id]),
    requestRevert: async (t, id) => { actions.push(['revert', id]); return { ok: true }; },
    setAutopilot: async (t, c) => { actions.push(['autopilot', c]); return c; },
    draftAction: async (t, id, action) => { actions.push(['draft', id, action]); return { status: action === 'approve' ? 'created_paused' : action === 'enable' ? 'enabled' : 'dismissed' }; },
    confirmAssets: async () => {},
  };
}

async function withApp(deps, fn) {
  const app = createApp(deps);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { app.close(); }
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const get = (base, path) => fetch(`${base}${path}`, { headers: { cookie: cookie() } });

test('accessFrom: the three levels, the numbers, and the one-off credit', () => {
  const locked = accessFrom({ paid: null, sub: null, tenant: { size_band: '10k' }, pricing: null, report: null, pending: [], ads: null });
  assert.deepStrictEqual({ l: locked.level, p: locked.paid, price: locked.price_usd, w: locked.waste_monthly_usd, c: locked.credit_applies }, { l: 'locked', p: false, price: 179, w: null, c: false });

  const unlocked = accessFrom({
    paid: { kind: 'audit_unlock' }, sub: null, tenant: { size_band: '4k' }, pricing: { matrix: { core: { '4k': 129 }, autopilot: { '4k': 199 }, scale: { '4k': 399 } } },
    report: { summary: { waste_monthly_usd: 740.4, currency: 'AED' } }, pending: [{ money_impact_usd: 300 }, { finding: { money_impact_monthly_usd: 40 } }], ads: { currency: 'AED' },
  });
  assert.deepStrictEqual({ l: unlocked.level, w: unlocked.waste_monthly_usd, pv: unlocked.pending_value_usd, n: unlocked.pending_count, c: unlocked.credit_applies, cur: unlocked.currency }, { l: 'unlocked', w: 740, pv: 340, n: 2, c: true, cur: 'AED' });

  for (const status of ['active', 'trialing', 'past_due']) {
    const a = accessFrom({ paid: { kind: 'audit_unlock' }, sub: { tier: 'core', status, price_usd: '129.00', stripe_customer_id: 'cus_1' }, tenant: null, pricing: null, report: null, pending: [], ads: null });
    assert.strictEqual(a.level, 'active', status);
    assert.strictEqual(a.credit_applies, false, 'a plan holder never earns a second credit');
  }
  const lapsed = accessFrom({ paid: { kind: 'audit_unlock' }, sub: { tier: 'core', status: 'canceled' }, tenant: null, pricing: null, report: null, pending: [], ads: null });
  assert.deepStrictEqual({ l: lapsed.level, c: lapsed.credit_applies }, { l: 'unlocked', c: false });
  // waste falls back to the snapshot when the summary has no headline
  const snap = accessFrom({ paid: null, sub: null, tenant: null, pricing: null, report: { findings_snapshot: [{ severity: 'warning', money: { impact_monthly_usd: 100 } }, { severity: 'info', money_impact_monthly_usd: 50 }] }, pending: [], ads: null });
  assert.strictEqual(snap.waste_monthly_usd, 100);
});

test('autopilotAllowed and safeNext', () => {
  assert.strictEqual(autopilotAllowed({ tier: 'autopilot', status: 'active' }), true);
  assert.strictEqual(autopilotAllowed({ tier: 'core', status: 'active' }), false);
  assert.strictEqual(autopilotAllowed({ tier: 'scale', status: 'canceled' }), false);
  assert.strictEqual(autopilotAllowed(null), false);
  assert.strictEqual(safeNext('/app/approvals'), '/app/approvals');
  assert.strictEqual(safeNext('/app/report/abc?x=1'), '/app/report/abc?x=1');
  assert.strictEqual(safeNext('https://evil.example/app'), '/app/approvals');
  assert.strictEqual(safeNext('//evil.example'), '/app/approvals');
  assert.strictEqual(safeNext('/ops'), '/app/approvals');
  assert.strictEqual(safeNext(undefined, '/app'), '/app');
});

test('gate: every write that needs a plan answers 402 at locked and unlocked, works at active', async () => {
  const writes = [
    ['/api/app/approve/ch1', null], ['/api/app/revert/ch0', null],
    ['/api/app/autopilot', { categories: { negatives: true } }],
    ['/api/app/drafts/d1/approve', {}], ['/api/app/drafts/d1/enable', {}],
  ];
  for (const level of ['locked', 'unlocked']) {
    const ds = dash(level);
    await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
      for (const [path, body] of writes) {
        const r = await post(base, path, body);
        assert.strictEqual(r.status, 402, `${level} ${path}`);
        const j = await r.json();
        assert.strictEqual(j.plan_required, true);
      }
      assert.deepStrictEqual(ds.actions, [], `${level}: nothing was written`);
      // free at every level: dismissing, and the draft dismiss
      assert.strictEqual((await post(base, '/api/app/dismiss/ch1', {})).status, 200);
      assert.strictEqual((await post(base, '/api/app/drafts/d1/dismiss', {})).status, 200);
      assert.deepStrictEqual(ds.actions, [['dismiss', 'ch1'], ['draft', 'd1', 'dismiss']]);
    });
  }
  const ds = dash('active');
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    for (const [path, body] of writes) assert.strictEqual((await post(base, path, body)).status, 200, `active ${path}`);
    assert.deepStrictEqual(ds.actions.map((a) => a[0]), ['approve', 'revert', 'autopilot', 'draft', 'draft']);
  });
});

test('gate: reads carry access at every level; /api/app/access stands alone; HTML fallback approve redirects to the plan', async () => {
  const ds = dash('unlocked');
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    for (const path of ['/api/app/home', '/api/app/approvals', '/api/app/ledger', '/api/app/settings', '/api/app/report/rep1', '/api/app/access']) {
      const j = await (await get(base, path)).json();
      assert.strictEqual(j.access.level, 'unlocked', path);
    }
    const rep = await (await get(base, '/api/app/report/rep1')).json();
    assert.strictEqual(rep.pending[0].id, 'ch1', 'the report carries the pending changes for Fix this');
    const led = await (await get(base, '/api/app/ledger')).json();
    assert.strictEqual(led.pending.length, 1, 'History can preview the queued fixes');
    const r = await fetch(`${base}/app/approve/ch1`, { method: 'POST', headers: { cookie: cookie() }, redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/app/plan');
    assert.deepStrictEqual(ds.actions, []);
  });
});

test('gate: a store without access() gates nothing (older adapters and existing tests)', async () => {
  const ds = dash('locked');
  delete ds.access;
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: ds, sessionSecret: SECRET }, async (base) => {
    assert.strictEqual((await post(base, '/api/app/approve/ch1')).status, 200);
    const j = await (await get(base, '/api/app/home')).json();
    assert.strictEqual(j.access, null);
  });
});

test('checkout: subscribe passes a sanitised next and the tapped change through; audit passes next', async () => {
  const seen = [];
  const checkout = {
    audit: async (a) => { seen.push(['audit', a]); return { url: 'https://stripe/a' }; },
    subscribe: async (a) => { seen.push(['subscribe', a]); return { url: 'https://stripe/s' }; },
    portal: async () => ({ url: 'x' }),
  };
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: dash('unlocked'), sessionSecret: SECRET, checkout }, async (base) => {
    assert.strictEqual((await post(base, '/api/checkout/subscribe', { tier: 'core', cadence: 'annual', next: '/app/report/rep1', change_id: 'ch1' })).status, 200);
    assert.strictEqual((await post(base, '/api/checkout/subscribe', { tier: 'core', next: 'https://evil.example/x' })).status, 200);
    assert.strictEqual((await post(base, '/api/checkout/audit', { kind: 'audit_unlock', next: '/app/report/rep1' })).status, 200);
  });
  assert.deepStrictEqual(seen[0][1], { tenantId: 'tn1', tier: 'core', cadence: 'annual', next: '/app/report/rep1', changeId: 'ch1' });
  assert.deepStrictEqual({ next: seen[1][1].next, c: seen[1][1].changeId }, { next: '/app/approvals', c: null });
  assert.deepStrictEqual(seen[2][1], { tenantId: 'tn1', kind: 'audit_unlock', next: '/app/report/rep1' });
});

test('webhook: subscription checkout approves the tapped change and records the customer of a $20 unlock', async () => {
  const calls = [];
  const store = {
    recordPayment: async (r) => calls.push(['payment', r]),
    approveOnCheckout: async (t, id) => { calls.push(['approve', t, id]); return true; },
    markCredited: async (t) => calls.push(['credited', t]),
    audit: async (e) => calls.push(['audit', e.event, e.detail]),
    upsertSubscription: async () => {}, markSubscription: async () => {}, ledger: async () => {}, scheduleEmail: async () => {}, tenantIdByCustomer: async () => null,
  };
  await handleWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', customer: 'cus_9', payment_intent: 'pi_1', amount_total: 2000, metadata: { tenant_id: 'tn1', kind: 'audit_unlock' } } } }, store);
  assert.strictEqual(calls[0][1].stripe_customer_id, 'cus_9');
  await handleWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_2', mode: 'subscription', customer: 'cus_9', metadata: { tenant_id: 'tn1', kind: 'subscription', tier: 'core', band: '4k', change_id: 'ch1' }, total_details: { amount_discount: 2000 } } } }, store);
  assert.ok(calls.some((c) => c[0] === 'approve' && c[2] === 'ch1'));
  assert.ok(calls.some((c) => c[0] === 'credited'));
  assert.ok(calls.some((c) => c[0] === 'audit' && c[1] === 'checkout_completed' && c[2].approved === true));
});

test('sign out expires the session cookie and lands on the start page', async () => {
  await withApp({ store: baseStore(), crawler: okCrawler, dashStore: dash('active'), sessionSecret: SECRET }, async (base) => {
    const r = await fetch(`${base}/auth/signout`, { method: 'POST', headers: { cookie: cookie() }, redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/app/start');
    assert.match(r.headers.get('set-cookie'), /insyt_s=;.*Max-Age=0/);
    const after = await fetch(`${base}/api/app/access`, { headers: { cookie: 'insyt_s=' } });
    assert.strictEqual(after.status, 401);
  });
});
