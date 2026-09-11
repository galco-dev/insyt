// Real asset-listing clients for discovery.js — build-doc §7 first half.
// These run right after the OAuth callback, over the freshly-exchanged access
// token (no google_connections row exists yet), so they take a raw token
// rather than the per-tenant auth client.
//
// createListClients({ accessToken, developerToken?, loginCustomerId?, fetchImpl })
// returns the discovery.js clients contract. Each thrown error carries {code}
// so discoverAssets captures per-source failures (§7 insufficient-role case).

const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const { VERSION: ADS_VERSION } = require('./fetch-ads');

function createListClients({ accessToken, developerToken, loginCustomerId, fetchImpl = fetch }) {
  async function api(url, init = {}) {
    const res = await fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`google api ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`);
      err.code = body.error && body.error.status ? body.error.status : `HTTP_${res.status}`;
      throw err;
    }
    return body;
  }

  return {
    // Ads: listAccessibleCustomers gives resource names; details need the
    // developer token. Without one we still return the ids (names unknown) —
    // discovery stays useful pre-Basic-access.
    listAdsAccounts: async () => {
      if (!developerToken) {
        const e = new Error('ads listing not configured (developer token pending)');
        e.code = 'NOT_CONFIGURED';
        throw e;
      }
      const headers = {
        'developer-token': developerToken,
        ...(loginCustomerId ? { 'login-customer-id': String(loginCustomerId).replace(/-/g, '') } : {}),
      };
      const listed = await api(`https://googleads.googleapis.com/${ADS_VERSION}/customers:listAccessibleCustomers`, { headers });
      const out = [];
      for (const rn of listed.resourceNames || []) {
        const cid = rn.split('/')[1];
        try {
          const r = await api(`https://googleads.googleapis.com/${ADS_VERSION}/customers/${cid}/googleAds:search`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.test_account, customer.status FROM customer' }),
          });
          const c = r.results && r.results[0] && r.results[0].customer;
          const row = {
            customerId: cid,
            descriptiveName: (c && c.descriptiveName) || null,
            currencyCode: (c && c.currencyCode) || null,
            manager: !!(c && c.manager),
            testAccount: !!(c && c.testAccount),
            status: (c && c.status) ? String(c.status).toLowerCase() : null,
            spend30dUsd: null, domains: [], campaigns: [],
          };
          // Signals for matching and choosing (fix plan move 2): what the
          // account spent in the last 30 days, where its ads point, and its
          // campaign names for the "leave alone" list. Best effort.
          if (!row.manager) {
            try {
              const camps = await api(`https://googleads.googleapis.com/${ADS_VERSION}/customers/${cid}/googleAds:search`, {
                method: 'POST', headers,
                body: JSON.stringify({ query: 'SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status != \'REMOVED\' LIMIT 200' }),
              });
              const byId = new Map();
              for (const x of camps.results || []) {
                const id = String(x.campaign && x.campaign.id);
                const prev = byId.get(id) || { id, name: (x.campaign && x.campaign.name) || id, status: String((x.campaign && x.campaign.status) || '').toLowerCase(), spend_30d_usd: 0 };
                prev.spend_30d_usd += Number((x.metrics && x.metrics.costMicros) || 0) / 1e6;
                byId.set(id, prev);
              }
              row.campaigns = [...byId.values()].map((k) => ({ ...k, spend_30d_usd: Math.round(k.spend_30d_usd * 100) / 100 })).sort((a, b) => b.spend_30d_usd - a.spend_30d_usd).slice(0, 60);
              row.spend30dUsd = Math.round(row.campaigns.reduce((s, k) => s + k.spend_30d_usd, 0) * 100) / 100;
            } catch { /* no spend signal; the account is still listed */ }
            try {
              const ads = await api(`https://googleads.googleapis.com/${ADS_VERSION}/customers/${cid}/googleAds:search`, {
                method: 'POST', headers,
                body: JSON.stringify({ query: 'SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status != \'REMOVED\' LIMIT 100' }),
              });
              const domains = new Set();
              for (const x of ads.results || []) {
                for (const u of (x.adGroupAd && x.adGroupAd.ad && x.adGroupAd.ad.finalUrls) || []) {
                  try { domains.add(new URL(u).hostname.replace(/^www\./, '').toLowerCase()); } catch { /* skip */ }
                }
              }
              row.domains = [...domains].slice(0, 20);
            } catch { /* no url signal */ }
          }
          out.push(row);
        } catch {
          out.push({ customerId: cid, descriptiveName: null, currencyCode: null, manager: false, testAccount: false, spend30dUsd: null, domains: [], campaigns: [] });
        }
      }
      return out;
    },

    // GA4: accountSummaries carries the whole account→property tree in one
    // call; web data streams fetched per property (measurement ids).
    listGa4Tree: async () => {
      const tree = [];
      let pageToken = '';
      do {
        const page = await api(`${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const acct of page.accountSummaries || []) {
          const properties = [];
          for (const p of acct.propertySummaries || []) {
            const propertyId = (p.property || '').split('/')[1];
            let dataStreams = [];
            try {
              const s = await api(`${ADMIN}/properties/${propertyId}/dataStreams?pageSize=200`);
              dataStreams = (s.dataStreams || [])
                .filter((d) => d.type === 'WEB_DATA_STREAM')
                .map((d) => ({
                  streamId: (d.name || '').split('/')[3],
                  measurementId: d.webStreamData && d.webStreamData.measurementId,
                  displayName: d.displayName || null,
                }));
            } catch { /* property visible but streams not — keep the property */ }
            // The Ads accounts this property is linked to (fix plan move 2):
            // the modern way an Ads account belongs to a site.
            let adsLinks = [];
            try {
              const l = await api(`${ADMIN}/properties/${propertyId}/googleAdsLinks`);
              adsLinks = (l.googleAdsLinks || []).map((x) => String(x.customerId || '').replace(/-/g, '')).filter(Boolean);
            } catch { /* not linked, or not visible */ }
            properties.push({ propertyId, displayName: p.displayName || null, currencyCode: null, dataStreams, adsLinks });
          }
          tree.push({ account: acct.displayName || (acct.account || '').split('/')[1], properties });
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return tree;
    },

    listGtmContainers: async () => {
      const accounts = await api(`${GTM}/accounts`);
      const out = [];
      for (const acct of accounts.account || []) {
        const containers = await api(`${GTM}/${acct.path}/containers`);
        out.push({
          accountId: acct.accountId,
          containers: (containers.container || []).map((c) => ({
            containerId: c.containerId, publicId: c.publicId, name: c.name,
          })),
        });
      }
      return out;
    },
  };
}

module.exports = { createListClients };
