const assert = require('node:assert');
const { test } = require('node:test');
const { provisionMissing } = require('../src/provision');

test('provisionMissing: creates GA4 property + stream and GTM container, records assets as ours; guides when no account exists', async () => {
  const calls = [];
  const auth = { api: async (tenantId, url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET' });
    if (url.endsWith('/v1beta/accounts')) return { accounts: [{ name: 'accounts/111' }] };
    if (url.endsWith('/v1beta/properties')) return { name: 'properties/222' };
    if (url.includes('/dataStreams')) return { name: 'properties/222/dataStreams/333', webStreamData: { measurementId: 'G-ABC123' } };
    if (url.endsWith('/tagmanager/v2/accounts')) return { account: [{ accountId: '444' }] };
    if (url.includes('/containers')) return { publicId: 'GTM-XYZ', containerId: '555' };
    return {};
  } };
  const writes = [];
  const db = { select: async () => [{ kind: 'ads_account' }], insert: async (t, rows) => { writes.push({ t, rows }); } };
  const r = await provisionMissing({ auth, db, tenantId: 't1', websiteUrl: 'https://thenaildxb.com/', displayName: 'The Nail DXB' });
  assert.deepStrictEqual({ ga4: r.ga4.measurement_id, gtm: r.gtm.public_id, guides: r.guides.length }, { ga4: 'G-ABC123', gtm: 'GTM-XYZ', guides: 0 });
  const assets = writes.filter((w) => w.t === 'assets').map((w) => w.rows[0]);
  assert.ok(assets.every((a) => a.created_by_us === true && a.linked === true));
  assert.deepStrictEqual(assets.map((a) => a.kind), ['ga4_property', 'gtm_container']);
  assert.strictEqual(assets[0].metadata.measurement_ids[0], 'G-ABC123');
  assert.ok(writes.some((w) => w.t === 'ledger'));

  const noAcct = { api: async () => ({}) };
  const r2 = await provisionMissing({ auth: noAcct, db: { select: async () => [], insert: async () => {} }, tenantId: 't1', websiteUrl: 'https://x.com', displayName: 'X' });
  assert.deepStrictEqual(r2.guides.map((g) => g.key), ['ga4_account', 'gtm_account']);
  assert.strictEqual(r2.ga4, null);
});
