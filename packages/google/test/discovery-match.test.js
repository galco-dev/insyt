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
