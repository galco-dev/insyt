// Railway `web` service bootstrap — wires createApp to the real stores.
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY (deploy/README.md).

require('../../../packages/shared/src/sentry').init({ service: 'web' });

const { createClient } = require('../../../packages/db/src/postgrest');
const { webStore, opsStore, dashStore, billingStore, authStore } = require('../../../packages/db/src/stores');
const { discoveryCrawl } = require('../../../packages/crawler/src/crawl');
const { handleWebhook } = require('../../../packages/billing/src/webhooks');
const { createApp } = require('./server');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const supa = webStore(db);

// Adapt the async Supabase-backed store to the server's store contract.
// (In-memory maps in tests; PostgREST rows here. The crawl cache keeps the
// polling endpoint cheap between PostgREST round-trips.)
const crawlCache = new Map();
const store = {
  createCrawl(row) {
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    crawlCache.set(tempId, row);
    supa.createCrawlRow(row).then((id) => { crawlCache.set(tempId, { ...row, db_id: id }); }).catch(() => {});
    return tempId;
  },
  getCrawl(id) { return crawlCache.get(id); },
  patchCrawl(id, patch) {
    const row = crawlCache.get(id);
    if (!row) return;
    Object.assign(row, patch);
    if (row.db_id) {
      supa.patchCrawlRow(row.db_id, {
        status: patch.status, tags_found: patch.result ? patch.result.tags_found : undefined,
        cms_fingerprint: patch.result ? patch.result.cms_fingerprint : undefined,
        booking_provider: patch.result ? patch.result.booking_provider : undefined,
        pages_crawled: patch.result ? patch.result.pages_crawled : undefined,
      }).catch(() => {});
    }
  },
  crawlCountForDomain(domain, sinceMs) {
    // Local window guard; the durable §5 limit rides on the crawls table and
    // is enforced again at the worker.
    return [...crawlCache.values()].filter((c) => c.domain === domain && c.created_at >= sinceMs).length;
  },
  getReportHtml: (id) => supa.getReportHtml(id),
  magicLinks: supa.magicLinks,
};

// BullMQ producer for /ops "run now".
let queue = { enqueue: async () => {} };
if (process.env.REDIS_URL) {
  // eslint-disable-next-line global-require
  const { Queue } = require('bullmq');
  const queues = new Map();
  queue = {
    enqueue: async (name, run) => {
      if (!queues.has(name)) queues.set(name, new Queue(name, { connection: { url: process.env.REDIS_URL } }));
      await queues.get(name).add('run', { run }, { jobId: `run:${run.tenant_id}:${run.id}` });
    },
  };
}

const app = createApp({
  store,
  crawler: { discoveryCrawl },
  opsStore: opsStore(db),
  dashStore: dashStore(db),
  queue,
  opsToken: process.env.OPS_TOKEN || null,
  sessionSecret: required('SESSION_SECRET'),
  billing: process.env.STRIPE_WEBHOOK_SECRET
    ? { handleWebhook, store: billingStore(db), webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
    : null,
  authBridge: {
    // Verify a Supabase access token by asking Supabase who it belongs to.
    verifySupabaseToken: async (token) => {
      const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const u = await res.json();
      const google = (u.identities || []).find((i) => i.provider === 'google');
      if (!google) return null;
      return { sub: google.id, email: u.email, name: u.user_metadata && u.user_metadata.full_name };
    },
    findOrCreateTenantByGoogle: (identity) => authStore(db).findOrCreateTenantByGoogle(identity),
  },
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`web listening on :${port}`));
