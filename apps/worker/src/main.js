// Railway `worker` service bootstrap — wires the §8 pipeline to real I/O.
// With GOOGLE_CLIENT_ID/SECRET present the REAL Google fetchers run (asset
// ids resolved from the tenant's linked assets rows); without them the fetch
// stages throw "not configured" and runs complete honestly degraded.
// The apply loop (§4) drains approved changes every minute when creds exist.

require('../../../packages/shared/src/sentry').init({ service: 'worker' });

const { createClient } = require('../../../packages/db/src/postgrest');
const { workerStore } = require('../../../packages/db/src/stores');
const { discoveryCrawl } = require('../../../packages/crawler/src/crawl');
const { createGoogleAuth } = require('../../../packages/google/src/client');
const { fetchGtmSnapshot } = require('../../../packages/google/src/fetch-gtm');
const { fetchGa4Config, fetchGa4Data } = require('../../../packages/google/src/fetch-ga4');
const { fetchAds } = require('../../../packages/google/src/fetch-ads');
const { createTransports } = require('../../../packages/tools/src/transports');
const { scanAndApply } = require('./apply');
const { start } = require('./service');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const q = (s) => encodeURIComponent(s);
const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const auth = googleConfigured
  ? createGoogleAuth({ db, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })
  : null;
const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3315824995';

async function linkedAsset(tenantId, kind) {
  return db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.${kind}&linked=eq.true&select=external_id,metadata&limit=1`, { single: true });
}

const notConfigured = (what) => async () => { throw new Error(`${what} not configured yet (needs Google OAuth client)`); };

const google = googleConfigured ? {
  fetchGtmSnapshot: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'gtm_container');
    if (!a) throw new Error('no linked GTM asset');
    return fetchGtmSnapshot({
      auth, tenantId, containerPublicId: a.external_id,
      accountId: a.metadata && a.metadata.account_id, containerId: a.metadata && a.metadata.container_id,
    });
  },
  fetchGa4Config: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ga4_property');
    if (!a) throw new Error('no linked GA4 asset');
    return fetchGa4Config({ auth, tenantId, propertyId: a.external_id });
  },
  fetchGa4Data: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ga4_property');
    if (!a) throw new Error('no linked GA4 asset');
    return fetchGa4Data({ auth, tenantId, propertyId: a.external_id });
  },
  fetchAds: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ads_account');
    if (!a) throw new Error('no linked Ads asset');
    if (!developerToken) throw new Error('ads reads not configured (developer token pending)');
    return fetchAds({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId });
  },
} : {
  fetchGtmSnapshot: notConfigured('gtm fetch'),
  fetchGa4Config: notConfigured('ga4 config fetch'),
  fetchGa4Data: notConfigured('ga4 data fetch'),
  fetchAds: notConfigured('ads fetch'),
};

const crawler = {
  verificationCrawl: async (url) => {
    if (!url) throw new Error('tenant has no website_url');
    const result = await discoveryCrawl(url);
    return {
      pages: (result.pages || []).map((p, i) => ({
        url: p.url, ok: p.ok, is_homepage: i === 0,
        gtm_containers_seen: result.tags_found.gtm_containers || [],
        collect_measurement_ids: result.tags_found.ga4_ids || [],
      })),
    };
  },
};

const model = {
  generate: async ({ system, prompt }) => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('narration not configured (no ANTHROPIC_API_KEY)');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.NARRATION_MODEL || 'claude-sonnet-4-5',
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`anthropic: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body.content[0].text;
  },
};

start({
  clients: { google, crawler, model },
  store: workerStore(db),
  redisUrl: required('REDIS_URL'),
}).then(() => console.log('worker consuming queues')).catch((e) => { console.error(e); process.exit(1); });

// §4 apply loop: approved changes → executor → transports, per minute.
if (googleConfigured) {
  const makeApi = async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ads_account');
    return createTransports({ auth, tenantId, developerToken, loginCustomerId, customerId: a ? a.external_id : null });
  };
  const makeCtx = async (tenantId) => {
    // Guardrail context from live data where reachable; conservative otherwise.
    let ads = null;
    try { ads = await google.fetchAds(tenantId); } catch { /* ads-less ctx below */ }
    const campaigns = new Map((ads ? ads.campaigns : []).map((c) => [String(c.id), c]));
    const [approvals, journey, keyEventsCfg] = await Promise.all([
      db.select('approvals', `tenant_id=eq.${q(tenantId)}&select=scope,target_id`),
      db.select('journey_state', `tenant_id=eq.${q(tenantId)}&select=gates&limit=1`, { single: true }),
      google.fetchGa4Config(tenantId).catch(() => null),
    ]);
    const pausedByUs = new Set((await db.select('changes',
      `tenant_id=eq.${q(tenantId)}&tool_id=eq.ads.pause_campaign&status=eq.applied&select=params`))
      .map((c) => c.params && String(c.params.campaign_id)).filter(Boolean));
    return {
      account: {
        daily_budget_total_usd: (ads ? ads.campaigns : []).reduce((s, c) => s + (c.budget_daily_usd || 0), 0) || 1,
        weekly_budget_delta_pct: 0, // per-week accounting joins the ledger later
        platform_min_daily_usd: 1,
      },
      campaign: (id) => campaigns.get(String(id)),
      convertingTerms: new Set((ads ? ads.search_terms : []).filter((t) => t.conversions_90d > 0).map((t) => t.term)),
      pausedByUs,
      primaryActionCount: ads ? ads.conversion_actions.filter((a) => a.primary).length : 0,
      keyEventCount: keyEventsCfg ? keyEventsCfg.key_events.length : 0,
      linkedAdsCustomerIds: ads ? [ads.customer_id] : [],
      approvals,
      gates: (journey && journey.gates) || {},
    };
  };
  setInterval(() => {
    scanAndApply({ db, makeApi, makeCtx })
      .then((r) => { if (r.tenants) console.log(`apply loop: ${r.applied} applied, ${r.failed} failed across ${r.tenants} tenant(s)`); })
      .catch((e) => console.error('apply loop failed:', e.message));
  }, 60_000);
  console.log('apply loop active (1-minute tick)');
} else {
  console.log('apply loop idle: Google OAuth client not configured');
}
