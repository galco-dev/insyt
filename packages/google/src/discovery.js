// Asset discovery — build-doc §7, first half.
// After scope step 2, enumerate everything the identity can reach and
// normalise into `assets`-row shape. API clients are injected so this
// unit-tests offline and swaps between real/stub implementations.
//
// clients contract:
//   listAdsAccounts()  -> [{ customerId, descriptiveName, currencyCode, manager, testAccount }]
//   listGa4Tree()      -> [{ account, properties: [{ propertyId, displayName, currencyCode,
//                           dataStreams: [{ streamId, measurementId, displayName }] }] }]
//   listGtmContainers()-> [{ accountId, containers: [{ containerId, publicId, name }] }]
// Each may throw { code: 'PERMISSION_DENIED' | ... } — §7 insufficient-role
// edge case; we capture per-source errors instead of failing discovery whole.

async function discoverAssets(clients) {
  const out = { assets: [], errors: [] };

  const capture = async (source, fn) => {
    try { await fn(); } catch (err) {
      out.errors.push({ source, code: (err && err.code) || 'UNKNOWN', message: String((err && err.message) || err) });
    }
  };

  await capture('ads', async () => {
    for (const a of await clients.listAdsAccounts()) {
      if (a.manager) continue; // MCC nodes are containers of accounts, not assets
      out.assets.push({
        kind: 'ads_account',
        external_id: String(a.customerId),
        display_name: a.descriptiveName || null,
        currency: a.currencyCode || null,
        metadata: { test_account: !!a.testAccount },
      });
    }
  });

  await capture('ga4', async () => {
    for (const acct of await clients.listGa4Tree()) {
      for (const p of acct.properties || []) {
        out.assets.push({
          kind: 'ga4_property',
          external_id: String(p.propertyId),
          display_name: p.displayName || null,
          currency: p.currencyCode || null,
          metadata: { account: acct.account },
        });
        for (const s of p.dataStreams || []) {
          out.assets.push({
            kind: 'ga4_stream',
            external_id: s.measurementId || String(s.streamId),
            display_name: s.displayName || null,
            currency: null,
            metadata: { property_id: String(p.propertyId), stream_id: String(s.streamId) },
          });
        }
      }
    }
  });

  await capture('gtm', async () => {
    for (const acct of await clients.listGtmContainers()) {
      for (const c of acct.containers || []) {
        out.assets.push({
          kind: 'gtm_container',
          external_id: c.publicId, // GTM-XXXX — what the crawler sees on-page
          display_name: c.name || null,
          currency: null,
          metadata: { account_id: String(acct.accountId), container_id: String(c.containerId) },
        });
      }
    }
  });

  return out;
}

module.exports = { discoverAssets };
