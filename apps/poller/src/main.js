require('../../../packages/shared/src/sentry').init({ service: 'poller' });

// Railway `poller` service bootstrap. Watch handlers arrive with the §9
// cascade wiring; until then the pump runs with an empty handler set —
// due watches are simply left untouched (never falsely resolved).

const { createClient } = require('../../../packages/db/src/postgrest');
const { opsStore } = require('../../../packages/db/src/stores');
const { discoveryCrawl } = require('../../../packages/crawler/src/crawl');
const { advance } = require('../../../packages/journeys/src/tag-install');
const { start } = require('./service');
const { makeHandlers, pumpTagInstalls } = require('./handlers');
const { pumpDailyPulse } = require('./pulse');
const { createGoogleAuth } = require('../../../packages/google/src/client');
const { fetchPulse } = require('../../../packages/google/src/fetch-ads');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const ops = opsStore(db);

const crawler = {
  verificationCrawl: async (url) => {
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

start({
  store: { dueWatches: ops.dueWatches, patchWatch: ops.patchWatch },
  handlers: makeHandlers({ db, crawler }),
});

// §9 tag-install polls run on their own 1-minute pump (journey_state, not watches).
setInterval(() => {
  pumpTagInstalls({ db, crawler, advance })
    .then((r) => { if (r.polled) console.log(`tag-install polls: ${r.polled}, verified: ${r.verified}`); })
    .catch((e) => console.error('tag-install pump failed:', e.message));
}, 60_000);

// §6.2 daily light pass: hourly pump, once a day per linked Ads account.
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
const q = (s) => encodeURIComponent(s);
let pulseGoogle = null;
if (googleClientId && googleClientSecret && developerToken) {
  const auth = createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret });
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3315824995';
  pulseGoogle = {
    fetchPulse: async (tenantId) => {
      const a = await db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.ads_account&linked=eq.true&select=external_id&limit=1`, { single: true });
      if (!a) throw new Error('no linked Ads asset');
      return fetchPulse({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId });
    },
  };
}
let queue = null;
if (process.env.REDIS_URL) {
  const { Queue } = require('bullmq');
  const queues = new Map();
  queue = {
    enqueue: async (name, run) => {
      if (!queues.has(name)) queues.set(name, new Queue(name, { connection: { url: process.env.REDIS_URL } }));
      await queues.get(name).add('run', { run }, { jobId: `run:${run.tenant_id}:${run.id}` });
    },
  };
}
const pulseTick = () => pumpDailyPulse({ db, google: pulseGoogle, queue })
  .then((r) => { if (r.checked) console.log(`daily pulse: ${r.checked} accounts, ${r.alerts} alerts, ${r.runs} triggered runs, ${r.errors} errors`); })
  .catch((e) => console.error('daily pulse failed:', e.message));
setInterval(pulseTick, 60 * 60_000);
setTimeout(pulseTick, 30_000);

console.log(`poller running: tag_alive + changeset_verify handlers, tag-install pump, daily pulse ${pulseGoogle ? 'active' : 'idle (Google not configured)'}${queue ? '' : ', no queue (triggered runs stay queued)'}`);
