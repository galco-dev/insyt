// Railway `worker` service bootstrap — wires the §8 pipeline to real I/O.
// Degrades honestly: Google fetch stages throw "not configured" until the
// GCP OAuth client exists, so runs complete degraded with config layers
// skipped; narration falls back to engine framing without ANTHROPIC_API_KEY.

const { createClient } = require('../../../packages/db/src/postgrest');
const { workerStore } = require('../../../packages/db/src/stores');
const { discoveryCrawl } = require('../../../packages/crawler/src/crawl');
const { start } = require('./service');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });

const notConfigured = (what) => async () => { throw new Error(`${what} not configured yet (needs Google OAuth client)`); };

const google = {
  fetchGtmSnapshot: notConfigured('gtm fetch'),
  fetchGa4Config: notConfigured('ga4 config fetch'),
  fetchGa4Data: notConfigured('ga4 data fetch'),
  fetchAds: notConfigured('ads fetch'),
};

const crawler = {
  // Verification mode rides on the discovery crawl for now; per-page collect
  // capture lands with the §9 cascade work.
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
