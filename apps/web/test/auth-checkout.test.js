// Tests: §6 OAuth route glue + §10 checkout client + webhook tenant fallback.

const { test } = require('node:test');
const assert = require('node:assert');
const { issueState, readState, storeDiscoveredAssets } = require('../src/auth-routes');
const { handleGoogleAuth } = require('../src/auth-routes');
const { createStripeCheckout, formEncode } = require('../../../packages/billing/src/checkout');
const { handleWebhook } = require('../../../packages/billing/src/webhooks');

const SECRET = 'test-secret';

// ---------------------------------------------------------------- state
test('oauth state round-trips and expires', () => {
  const now = 1_000_000;
  const state = issueState({ tenantId: 't1', step: 'discovery', secret: SECRET, now });
  assert.deepEqual(readState(state, SECRET, now + 60_000), { tenantId: 't1', step: 'discovery', site: '' });
  assert.equal(readState(state, SECRET, now + 16 * 60_000), null, 'expired');
  assert.equal(readState(state, 'other-secret', now), null, 'wrong secret');
  assert.equal(readState(`${state}x`, SECRET, now), null, 'tampered');
});

// ---------------------------------------------------------------- discovery storage
function fakeDb(rows = {}) {
  const calls = { inserts: [], updates: [] };
  return {
    calls,
    select: async (table, query, opts) => {
      const data = rows[table] || [];
      if (opts && opts.single) return data[0] || null;
      return data;
    },
    insert: async (table, list) => { calls.inserts.push({ table, list }); return list.map((r, i) => ({ id: `id${i}`, ...r })); },
    update: async (table, query, patch) => { calls.updates.push({ table, query, patch }); },
  };
}

test('storeDiscoveredAssets inserts fresh assets, marks crawl matches linked', async () => {
  const db = fakeDb({ assets: [{ kind: 'gtm_container', external_id: 'GTM-OLD', linked: false }] });
  const assets = [
    { kind: 'gtm_container', external_id: 'GTM-ABC', display_name: 'Main', currency: null, metadata: {} },
    { kind: 'gtm_container', external_id: 'GTM-OLD', display_name: 'Old', currency: null, metadata: {} },
    { kind: 'ads_account', external_id: '123', display_name: 'Ads', currency: 'USD', metadata: {} },
  ];
  const tagsFound = { gtm_containers: ['GTM-ABC', 'GTM-OLD'], ga4_ids: [], aw_conversion_ids: [] };
  const result = await storeDiscoveredAssets({ db, tenantId: 't1', assets, tagsFound });
  assert.equal(result.matched, 2);
  const inserted = db.calls.inserts[0].list;
  assert.equal(inserted.length, 2, 'GTM-OLD already existed');
  const abc = inserted.find((r) => r.external_id === 'GTM-ABC');
  assert.equal(abc.linked, true, 'on-site container pre-linked');
  assert.equal(inserted.find((r) => r.external_id === '123').linked, false);
  // existing matched row upgraded to linked
  assert.ok(db.calls.updates.some((u) => u.query.includes('GTM-OLD') && u.patch.linked === true));
});

// ---------------------------------------------------------------- callback route
function fakeRes() {
  const res = { headers: null, code: null, body: '' };
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers || {}; };
  res.end = (b) => { res.body = b || ''; };
  return res;
}

test('callback exchanges code, upserts connection, discovers, redirects to confirm', async () => {
  const now = () => 5_000_000;
  const state = issueState({ tenantId: 't1', step: 'discovery', secret: SECRET, now: now() });
  const db = fakeDb({
    users: [{ id: 'u1', google_sub: 'sub-owner' }],
    google_connections: [],
    tenants: [{ website_url: 'https://example.com' }],
    crawls: [{ tags_found: { gtm_containers: ['GTM-X'], ga4_ids: [], aw_conversion_ids: [] } }],
    assets: [],
  });
  const deps = {
    db,
    config: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb' },
    sessionSecret: SECRET,
    now,
    fetchUserinfo: async () => ({ sub: 'sub-owner', email: 'owner@example.com' }),
    exchangeCode: async () => ({
      tokens: { access_token: 'at', refresh_token: 'rt', expires_at: 1 },
      grantedScopes: [
        'https://www.googleapis.com/auth/adwords',
        'https://www.googleapis.com/auth/analytics.readonly',
        'https://www.googleapis.com/auth/tagmanager.readonly',
      ],
    }),
    listClients: () => ({}),
    discoverAssets: async () => ({
      assets: [{ kind: 'gtm_container', external_id: 'GTM-X', display_name: 'X', currency: null, metadata: {} }],
      errors: [],
    }),
  };
  const res = fakeRes();
  const u = new URL(`http://x/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  const handled = await handleGoogleAuth({ method: 'GET' }, res, u, null, deps);
  assert.equal(handled, true);
  assert.equal(res.code, 302);
  assert.match(res.headers.location, /^\/app\/confirm\?found=1&matched=1/);
  const connInsert = db.calls.inserts.find((i) => i.table === 'google_connections');
  assert.ok(connInsert, 'connection created');
  assert.equal(connInsert.list[0].refresh_token, 'rt');
  assert.equal(connInsert.list[0].scope_level, 'readonly');
  assert.equal(connInsert.list[0].status, 'valid');
});

test('callback: a different Google identity on a signed-in browser switches tenant, never overwrites the current one', async () => {
  // Regression: 31 Aug 2026 — signing in as info@jobpeak.net while the Nail DXB
  // session cookie was set bound jobpeak's refresh token + assets to the Nail tenant.
  const now = () => 5_000_000;
  const state = issueState({ tenantId: 't-nail', step: 'discovery', secret: SECRET, now: now(), site: 'jobpeak.net' });
  // Query-aware fake: rows are keyed by the tenant/user the query names.
  const db = fakeDb();
  db.select = async (table, query, opts) => {
    let data = [];
    if (table === 'users') {
      if (query.includes('t-nail')) data = [{ id: 'u-nail', google_sub: 'sub-nail' }];
      if (query.includes('t-jobpeak')) data = [{ id: 'u-jobpeak', google_sub: 'sub-jobpeak' }];
    }
    if (table === 'google_connections' && query.includes('u-nail')) data = [{ id: 'c-nail', refresh_token: 'rt-nail', granted_scopes: [] }];
    if (table === 'tenants') data = [{ website_url: null }];
    return opts && opts.single ? (data[0] || null) : data;
  };
  let created = null;
  const deps = {
    db,
    config: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb' },
    sessionSecret: SECRET,
    now,
    fetchUserinfo: async () => ({ sub: 'sub-jobpeak', email: 'info@jobpeak.net' }),
    findOrCreateTenantByGoogle: async (who) => { created = who; return 't-jobpeak'; },
    issueSession: ({ tenantId }) => `sess-${tenantId}`,
    cookieFor: (s) => `insyt=${s}`,
    exchangeCode: async () => ({ tokens: { access_token: 'at', refresh_token: 'rt-jobpeak' }, grantedScopes: ['https://www.googleapis.com/auth/adwords'] }),
    listClients: () => ({}),
    discoverAssets: async () => ({ assets: [], errors: [] }),
  };
  const res = fakeRes();
  const u = new URL(`http://x/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  await handleGoogleAuth({ method: 'GET' }, res, u, { tenantId: 't-nail' }, deps);
  assert.equal(res.code, 302);
  assert.equal(created && created.sub, 'sub-jobpeak', 'looked up / created the OTHER identity\'s tenant');
  assert.equal(res.headers['set-cookie'], 'insyt=sess-t-jobpeak', 'session switched to the new tenant');
  // The Nail connection must be untouched: no update carrying the jobpeak token.
  assert.ok(!db.calls.updates.some((x) => x.table === 'google_connections' && x.patch.refresh_token === 'rt-jobpeak' && x.query.includes('c-nail')));
  // website_url lookups/inserts target the switched tenant only.
  assert.ok(db.calls.inserts.every((i) => i.table !== 'assets' || i.list.every((r) => r.tenant_id === 't-jobpeak')));
});

test('callback with bad state fails without touching google', async () => {
  const res = fakeRes();
  const u = new URL('http://x/auth/google/callback?code=abc&state=garbage');
  const handled = await handleGoogleAuth({ method: 'GET' }, res, u, null, {
    db: fakeDb(), config: {}, sessionSecret: SECRET, now: () => 1,
    exchangeCode: async () => { throw new Error('must not be called'); },
  });
  assert.equal(handled, true);
  assert.equal(res.code, 400);
});

test('start: signed-out discovery goes to google (one-tap sign-in), signed-out write goes home, signed-in to google', async () => {
  const deps = { db: fakeDb(), config: { clientId: 'cid', redirectUri: 'https://app/cb' }, sessionSecret: SECRET, now: () => 1 };
  const res0 = fakeRes();
  await handleGoogleAuth({ method: 'GET' }, res0, new URL('http://x/auth/google/start?step=discovery&site=thenaildxb.net'), null, deps);
  assert.match(res0.headers.location, /^https:\/\/accounts\.google\.com/);
  assert.match(res0.headers.location, /openid/);
  const res1 = fakeRes();
  await handleGoogleAuth({ method: 'GET' }, res1, new URL('http://x/auth/google/start?step=write'), null, deps);
  assert.equal(res1.headers.location, '/');
  const res2 = fakeRes();
  await handleGoogleAuth({ method: 'GET' }, res2, new URL('http://x/auth/google/start?step=discovery'), { tenantId: 't1' }, deps);
  assert.match(res2.headers.location, /^https:\/\/accounts\.google\.com/);
  assert.match(res2.headers.location, /adwords/);
});

test('agency join (fix plan move 14): the join cookie binds the arriving Google identity to the seat and lands on the console', async () => {
  const now = () => 5_000_000;
  const state = issueState({ tenantId: '', step: 'discovery', secret: SECRET, now: now() });
  const activated = [];
  const deps = {
    db: fakeDb({ users: [{ id: 'u1', google_sub: 'sub-new' }], google_connections: [], tenants: [], crawls: [], assets: [] }),
    config: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb' }, sessionSecret: SECRET, now,
    fetchUserinfo: async () => ({ sub: 'sub-new', email: 'mo@northlight.ae', name: 'Mo' }),
    exchangeCode: async () => ({ tokens: { access_token: 'at', refresh_token: 'rt' }, grantedScopes: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/tagmanager.readonly'] }),
    listClients: () => ({}), discoverAssets: async () => ({ assets: [], errors: [] }),
    findOrCreateTenantByGoogle: async () => 'tn-mo',
    issueSession: ({ tenantId }) => `sess-${tenantId}`, cookieFor: (s) => `insyt_s=${s}; Path=/`,
    activateSeat: async (seatId, who) => { activated.push([seatId, who]); return { ok: true, agency_id: 'ag1' }; },
  };
  const res = fakeRes();
  const u = new URL(`http://x/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  await handleGoogleAuth({ method: 'GET', headers: { cookie: 'insyt_join=seat:seat-9' } }, res, u, null, deps);
  assert.strictEqual(res.code, 302);
  assert.strictEqual(res.headers.location, '/app/agency');
  assert.deepStrictEqual(activated, [['seat-9', { tenantId: 'tn-mo', googleSub: 'sub-new', email: 'mo@northlight.ae' }]]);
  const cookies = [].concat(res.headers['set-cookie']);
  assert.ok(cookies.some((c) => /^insyt_s=sess-tn-mo/.test(c)), 'signed in');
  assert.ok(cookies.some((c) => /^insyt_join=; .*Max-Age=0/.test(c)), 'join cookie cleared');

  // Agency plan move 4: the wrong Google account is refused before any tenant is created,
  // the join cookie stays so they can try again; the right one consumes the link and never runs discovery.
  const discovered = [];
  const consumed = [];
  const created = [];
  const deps2 = { ...deps,
    findOrCreateTenantByGoogle: async () => { created.push(1); return 'tn-mo'; },
    discoverAssets: async () => { discovered.push(1); return { assets: [], errors: [] }; },
    checkSeat: async (id, who) => (who.email === 'mo@northlight.ae' ? { ok: true, agency_id: 'ag1', already: false } : { ok: false, reason: 'wrong_account', invited: 'mo@northlight.ae' }),
    consumeLink: async (id) => { consumed.push(id); },
  };
  const wrong = fakeRes();
  await handleGoogleAuth({ method: 'GET', headers: { cookie: 'insyt_join=seat:seat-9.link-1' } }, wrong, u, null, { ...deps2, fetchUserinfo: async () => ({ sub: 'sub-x', email: 'stranger@gmail.com' }) });
  assert.strictEqual(wrong.code, 400);
  assert.match(wrong.body, /This invite was for mo@northlight\.ae/);
  assert.strictEqual(created.length, 0, 'no tenant for the wrong person');
  const right = fakeRes();
  await handleGoogleAuth({ method: 'GET', headers: { cookie: 'insyt_join=seat:seat-9.link-1' } }, right, u, null, deps2);
  assert.strictEqual(right.headers.location, '/app/agency');
  assert.deepStrictEqual(consumed, ['link-1'], 'the link is consumed when the seat binds');
  assert.strictEqual(discovered.length, 0, 'joining an agency never runs discovery');

  // Agency plan move 5: a client who already owns a business attaches it to the agency's account.
  const adopted = [];
  const acc = fakeRes();
  await handleGoogleAuth({ method: 'GET', headers: { cookie: 'insyt_join=account:tn-shell.link-2' } }, acc, u, null, { ...deps2, findOrCreateTenantByGoogle: async () => 'tn-existing', adoptTenant: async (shell, real) => { adopted.push([shell, real]); return { ok: true }; } });
  assert.deepStrictEqual(adopted, [['tn-shell', 'tn-existing']]);
  assert.deepStrictEqual(consumed, ['link-1', 'link-2']);
  assert.match(acc.headers.location, /^\/app\/confirm/);
});

test('write step (fix plan move 5): asked in place, next rides in the state, the callback returns there', async () => {
  const now = () => 5_000_000;
  const deps = {
    db: fakeDb({ users: [{ id: 'u1', google_sub: 'sub-owner' }], google_connections: [{ id: 'gc1', refresh_token: 'rt', granted_scopes: [] }] }),
    config: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb' }, sessionSecret: SECRET, now,
    fetchUserinfo: async () => ({ sub: 'sub-owner', email: 'owner@example.com' }),
    exchangeCode: async () => ({ tokens: { access_token: 'at' }, grantedScopes: [
      'https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/tagmanager.readonly',
      'https://www.googleapis.com/auth/analytics.edit', 'https://www.googleapis.com/auth/tagmanager.edit.containers', 'https://www.googleapis.com/auth/tagmanager.publish',
    ] }),
  };
  const res0 = fakeRes();
  await handleGoogleAuth({ method: 'GET' }, res0, new URL('http://x/auth/google/start?step=write&next=%2Fapp%2Fapprovals'), { tenantId: 't1' }, deps);
  assert.match(res0.headers.location, /^https:\/\/accounts\.google\.com/);
  const state = new URL(res0.headers.location).searchParams.get('state');
  assert.deepEqual(readState(state, SECRET, now()), { tenantId: 't1', step: 'write', site: '/app/approvals' });
  const resBad = fakeRes();
  await handleGoogleAuth({ method: 'GET' }, resBad, new URL('http://x/auth/google/start?step=write&next=https%3A%2F%2Fevil.example'), { tenantId: 't1' }, deps);
  assert.equal(readState(new URL(resBad.headers.location).searchParams.get('state'), SECRET, now()).site, '', 'only /app paths ride along');
  const res1 = fakeRes();
  await handleGoogleAuth({ method: 'GET' }, res1, new URL(`http://x/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`), { tenantId: 't1' }, deps);
  assert.equal(res1.code, 302);
  assert.equal(res1.headers.location, '/app/approvals?fix_access=1');
  const patch = deps.db.calls.updates.find((u) => u.table === 'google_connections');
  assert.ok(['write', 'create'].includes(patch.patch.scope_level), 'the write ladder step is fully granted');
});

// ---------------------------------------------------------------- checkout client
test('formEncode nests stripe-style', () => {
  assert.equal(
    formEncode({ mode: 'payment', line_items: [{ price: 'p1', quantity: 1 }], metadata: { tenant_id: 't1' } }),
    'mode=payment&line_items%5B0%5D%5Bprice%5D=p1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Btenant_id%5D=t1',
  );
});

test('auditCheckout finds price by metadata key and stamps tenant', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init.body });
    if (url.includes('/prices')) {
      return { ok: true, json: async () => ({ data: [{ id: 'price_1', metadata: { key: 'insyt_audit_unlock' } }], has_more: false }) };
    }
    return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe/cs_1' }) };
  };
  const stripe = createStripeCheckout({ secretKey: 'sk_test_x', fetchImpl });
  const r = await stripe.auditCheckout({ tenantId: 't9', kind: 'audit_unlock', successUrl: 'https://a/s', cancelUrl: 'https://a/c' });
  assert.equal(r.url, 'https://checkout.stripe/cs_1');
  const create = requests.find((x) => x.url.includes('/checkout/sessions'));
  assert.match(create.body, /metadata%5Btenant_id%5D=t9/);
  assert.match(create.body, /price%5D=price_1/);
});

// ---------------------------------------------------------------- webhook tenant fallback
test('webhook (fix plan move 13): a refunded audit fee relocks; cancelling stamps canceled_at', async () => {
  const calls = [];
  const store = {
    tenantIdByCustomer: async () => 't1', recordPayment: async () => {}, upsertSubscription: async () => {},
    markSubscription: async (id, patch) => calls.push(['sub', id, patch]),
    markRefunded: async (pi) => { calls.push(['refund', pi]); return { tenant_id: 't1' }; },
    ledger: async (e) => calls.push(['ledger', e.summary_text]), audit: async (e) => calls.push(['audit', e.event]),
  };
  const refund = await handleWebhook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', amount_refunded: 2000 } } }, store);
  assert.deepStrictEqual(refund, { handled: true });
  assert.deepStrictEqual(calls[0], ['refund', 'pi_1']);
  await handleWebhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {} } } }, store);
  const sub = calls.find((c) => c[0] === 'sub');
  assert.strictEqual(sub[2].status, 'canceled');
  assert.ok(sub[2].canceled_at, 'canceled_at stamped');
  assert.ok(calls.some((c) => c[0] === 'ledger' && /Undo stays free for 30 days/.test(c[1])));
});

test('subscriptionCheckout (fix plan move 16): asks Stripe for tax and a tax id, and falls back cleanly when Tax is off', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body || '' });
    if (/\/prices/.test(url)) return { ok: true, json: async () => ({ data: [{ id: 'price_1', lookup_key: 'insyt_core_4k_monthly', metadata: { key: 'insyt_core_4k_monthly' } }] }) };
    if (/checkout\/sessions/.test(url) && /automatic_tax/.test(init.body)) return { ok: false, status: 400, json: async () => ({ error: { message: 'You must enable Stripe Tax before using automatic_tax' } }) };
    return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout' }) };
  };
  const stripe = createStripeCheckout({ secretKey: 'sk', fetchImpl });
  const r = await stripe.subscriptionCheckout({ tenantId: 't1', tier: 'core', band: '4k', successUrl: 'https://a', cancelUrl: 'https://b' });
  assert.strictEqual(r.url, 'https://checkout');
  const sessions = calls.filter((c) => /checkout\/sessions/.test(c.url));
  assert.strictEqual(sessions.length, 2, 'once with tax, once without');
  assert.match(sessions[0].body, /tax_id_collection/);
  assert.ok(!/automatic_tax/.test(sessions[1].body));
});

test('webhook prefers metadata.tenant_id over customer lookup', async () => {
  const seen = [];
  const store = {
    tenantIdByCustomer: async () => { throw new Error('should not need customer lookup'); },
    recordPayment: async (row) => seen.push(row),
    audit: async () => {},
  };
  const r = await handleWebhook({
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', customer: 'cus_new', metadata: { tenant_id: 't7', kind: 'audit_unlock' }, payment_intent: 'pi_1', amount_total: 2000 } },
  }, store);
  assert.equal(r.handled, true);
  assert.equal(seen[0].tenant_id, 't7');
  assert.equal(seen[0].amount_usd, 20);
});

test('subscriptionCheckout: saved customer first, the audit fee as a one-off coupon, the tapped change in metadata (gated platform)', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    if (url.includes('/prices')) return { ok: true, json: async () => ({ data: [{ id: 'price_core', metadata: { key: 'insyt_core_4k_monthly' } }], has_more: false }) };
    if (url.endsWith('/coupons/insyt_audit_credit_20') && init.method === 'GET') return { ok: false, status: 404, json: async () => ({ error: { message: 'No such coupon' } }) };
    if (url.endsWith('/coupons')) return { ok: true, json: async () => ({ id: 'insyt_audit_credit_20' }) };
    return { ok: true, json: async () => ({ id: 'cs_2', url: 'https://checkout.stripe/cs_2' }) };
  };
  const stripe = createStripeCheckout({ secretKey: 'sk_test_x', fetchImpl });
  const r = await stripe.subscriptionCheckout({ tenantId: 't9', tier: 'core', band: '4k', cadence: 'monthly', customerEmail: 'a@b.c', customerId: 'cus_9', creditUsd: 20, changeId: 'ch1', successUrl: 'https://a/s', cancelUrl: 'https://a/c' });
  assert.equal(r.url, 'https://checkout.stripe/cs_2');
  const coupon = requests.find((x) => x.url.endsWith('/coupons') && x.method === 'POST');
  assert.match(coupon.body, /amount_off=2000/);
  assert.match(coupon.body, /duration=once/);
  const create = requests.find((x) => x.url.includes('/checkout/sessions'));
  assert.match(create.body, /(^|&)customer=cus_9(&|$)/);
  assert.doesNotMatch(create.body, /customer_email/);
  assert.match(create.body, /discounts%5B0%5D%5Bcoupon%5D=insyt_audit_credit_20/);
  assert.match(create.body, /metadata%5Bchange_id%5D=ch1/);
  // no credit, no customer: email path, no discounts
  const r2 = await stripe.subscriptionCheckout({ tenantId: 't9', tier: 'core', band: '4k', customerEmail: 'a@b.c', successUrl: 'https://a/s', cancelUrl: 'https://a/c' });
  assert.equal(r2.id, 'cs_2');
  const create2 = requests.filter((x) => x.url.includes('/checkout/sessions')).at(-1);
  assert.match(create2.body, /customer_email=a%40b.c/);
  assert.doesNotMatch(create2.body, /discounts/);
});
