const assert = require('node:assert');
const { test } = require('node:test');
const { discoverAssets } = require('../src/discovery');
const { matchAssets } = require('../src/match');

const STUB_CLIENTS = {
  listAdsAccounts: async () => [
    { customerId: '6424596144', descriptiveName: 'JobPeak', currencyCode: 'AED', manager: false },
    { customerId: '3315824995', descriptiveName: 'Galco MCC', manager: true },
  ],
  listGa4Tree: async () => [
    {
      account: 'accounts/100',
      properties: [{
        propertyId: '333222111', displayName: 'Salon site', currencyCode: 'AED',
        dataStreams: [{ streamId: '555', measurementId: 'G-FIXTURE001', displayName: 'Web' }],
      }],
    },
  ],
  listGtmContainers: async () => [
    { accountId: '900', containers: [{ containerId: '42', publicId: 'GTM-TEST123', name: 'Site container' }] },
  ],
};

test('discoverAssets: normalises all three trees, skips MCC nodes', async () => {
  const { assets, errors } = await discoverAssets(STUB_CLIENTS);
  assert.deepStrictEqual(errors, []);
  const kinds = assets.map((a) => a.kind).sort();
  assert.deepStrictEqual(kinds, ['ads_account', 'ga4_property', 'ga4_stream', 'gtm_container']);
  const gtm = assets.find((a) => a.kind === 'gtm_container');
  assert.strictEqual(gtm.external_id, 'GTM-TEST123');
});

test('discoverAssets: per-source failure captured, discovery continues (§7 insufficient role)', async () => {
  const clients = {
    ...STUB_CLIENTS,
    listAdsAccounts: async () => { const e = new Error('no role'); e.code = 'PERMISSION_DENIED'; throw e; },
  };
  const { assets, errors } = await discoverAssets(clients);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].source, 'ads');
  assert.strictEqual(errors[0].code, 'PERMISSION_DENIED');
  assert.ok(assets.some((a) => a.kind === 'gtm_container'), 'other sources still enumerated');
});

test('matchAssets (fix plan move 2): an Ads account matches through the GA4 link, or through its ads pointing at the site', () => {
  const tags = { gtm_containers: [], ga4_ids: ['G-ABC'], aw_conversion_ids: [] };
  const assets = [
    { kind: 'ga4_stream', external_id: 'G-ABC', metadata: { property_id: 'p1' } },
    { kind: 'ga4_property', external_id: 'p1', metadata: { ads_links: ['6424596144'] } },
    { kind: 'ads_account', external_id: '642-459-6144', metadata: { domains: [] } },
    { kind: 'ads_account', external_id: '7307442495', metadata: { domains: ['www.jobpeak.net'] } },
    { kind: 'ads_account', external_id: '1112223333', metadata: { domains: ['other.example'] } },
  ];
  const { matched, unmatched, confidence } = matchAssets(tags, assets, { domain: 'jobpeak.net' });
  const via = Object.fromEntries(matched.map((m) => [m.external_id, m.matched_via]));
  assert.strictEqual(via['642-459-6144'], 'ga4_link');
  assert.strictEqual(via['7307442495'], 'final_url_domain');
  assert.deepStrictEqual(unmatched.map((u) => u.external_id), ['1112223333'], 'a sibling business stays unmatched');
  assert.ok(confidence >= 0.85);
  const noSite = matchAssets({ gtm_containers: [], ga4_ids: [], aw_conversion_ids: [] }, assets.slice(2));
  assert.strictEqual(noSite.matched.length, 0, 'no signal, no link, never a guess');
});

test('listAdsAccounts (fix plan move 17): clients reached only through a manager account are listed with the manager as login', async () => {
  const { createListClients } = require('../src/list-clients');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, login: init.headers['login-customer-id'] || null, body: init.body ? JSON.parse(init.body).query : '' });
    const ok = (body) => ({ ok: true, json: async () => body });
    if (/listAccessibleCustomers/.test(url)) return ok({ resourceNames: ['customers/111'] });
    if (/customers\/111\/googleAds:search/.test(url) && /FROM customer$/.test(calls.at(-1).body)) return ok({ results: [{ customer: { id: '111', descriptiveName: 'Northlight MCC', manager: true } }] });
    if (/customers\/111\/googleAds:search/.test(url) && /customer_client/.test(calls.at(-1).body)) return ok({ results: [
      { customerClient: { id: '222', descriptiveName: 'Glow Studio', currencyCode: 'AED', manager: false, status: 'ENABLED', level: 1 } },
      { customerClient: { id: '333', descriptiveName: 'Sub manager', manager: true, level: 1 } },
    ] });
    if (/customers\/222\/googleAds:search/.test(url) && /FROM campaign/.test(calls.at(-1).body)) return ok({ results: [{ campaign: { id: '9', name: 'Brand', status: 'ENABLED' }, metrics: { costMicros: '5000000' } }] });
    return ok({ results: [] });
  };
  const clients = createListClients({ accessToken: 't', developerToken: 'd', loginCustomerId: null, fetchImpl });
  const rows = await clients.listAdsAccounts();
  const glow = rows.find((r) => r.customerId === '222');
  assert.ok(glow, 'the client under the manager is listed');
  assert.deepStrictEqual(glow.underManager, { id: '111', name: 'Northlight MCC' });
  assert.strictEqual(glow.spend30dUsd, 5, 'its signals were read through the manager');
  const viaManager = calls.filter((c) => /customers\/222\//.test(c.url));
  assert.ok(viaManager.length > 0 && viaManager.every((c) => c.login === '111'), 'every read of the client logs in through the manager');
  assert.ok(!rows.some((r) => r.customerId === '333'), 'a sub-manager is a container, not an account');
});

test('rediscoverTenant (fix plan move 10): stores what is new over the tenant connection, never unlinks, and logs it', async () => {
  const { rediscoverTenant } = require('../src/discovery-store');
  const inserts = []; const updates = [];
  const db = {
    select: async (table, query, opts) => {
      if (table === 'tenants') return { website_url: 'jobpeak.net' };
      if (table === 'crawls') return { tags_found: { gtm_containers: ['GTM-1'], ga4_ids: [], aw_conversion_ids: [] } };
      if (table === 'assets') return [{ kind: 'gtm_container', external_id: 'GTM-1', linked: true }];
      return opts && opts.single ? null : [];
    },
    insert: async (table, rows) => { inserts.push({ table, rows }); return rows; },
    update: async (table, query, patch) => { updates.push({ table, query, patch }); },
  };
  const r = await rediscoverTenant({
    db, auth: { accessToken: async () => 'tok' }, developerToken: 'dev', loginCustomerId: '1', tenantId: 't1',
    listClients: () => ({}),
    discover: async () => ({ assets: [
      { kind: 'gtm_container', external_id: 'GTM-1', display_name: 'Main', currency: null, metadata: {} },
      { kind: 'ads_account', external_id: '999', display_name: 'New ads', currency: 'USD', metadata: { domains: ['other.example'] } },
    ], errors: [] }),
  });
  assert.strictEqual(r.inserted, 1);
  assert.deepStrictEqual(r.fresh_unmatched, [{ kind: 'ads_account', external_id: '999', display_name: 'New ads' }]);
  const assetInsert = inserts.find((i) => i.table === 'assets');
  assert.strictEqual(assetInsert.rows[0].linked, false, 'a new account with no signal waits for a tap');
  assert.ok(inserts.find((i) => i.table === 'audit_log' && i.rows[0].event === 'rediscovered'));
  assert.ok(!updates.some((u) => u.patch && u.patch.linked === false), 'never unlinks');
});

test('matchAssets: container + G-ID on site match, property matches through stream', async () => {
  const { assets } = await discoverAssets(STUB_CLIENTS);
  const crawlTags = { gtm_containers: ['GTM-TEST123'], ga4_ids: ['G-FIXTURE001'], legacy_ua: [], aw_conversion_ids: [] };
  const { matched, unmatched, confidence } = matchAssets(crawlTags, assets);
  const matchedKinds = matched.map((m) => m.kind).sort();
  assert.deepStrictEqual(matchedKinds, ['ga4_property', 'ga4_stream', 'gtm_container']);
  assert.ok(unmatched.every((a) => a.kind === 'ads_account'), 'ads matches only via AW- tag');
  assert.ok(confidence >= 0.9, `two independent signals compound: ${confidence}`);
});

test('matchAssets: nothing on site → zero confidence, all collapsed', async () => {
  const { assets } = await discoverAssets(STUB_CLIENTS);
  const { matched, confidence } = matchAssets({ gtm_containers: [], ga4_ids: [] }, assets);
  assert.strictEqual(matched.length, 0);
  assert.strictEqual(confidence, 0);
});
