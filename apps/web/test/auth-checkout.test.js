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
    users: [{ id: 'u1' }],
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
