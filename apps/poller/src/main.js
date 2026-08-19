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

console.log('poller running: tag_alive + changeset_verify handlers, tag-install pump');
