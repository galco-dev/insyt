require('../../../packages/shared/src/sentry').init({ service: 'cron' });

// Railway `cron` service bootstrap — the real clock over Supabase + BullMQ.
// Token sweep is a no-op until the Google OAuth client exists (it logs the
// connections it WOULD validate, so the ledger of intent is visible).

const { Queue } = require('bullmq');
const { createClient } = require('../../../packages/db/src/postgrest');
const { opsStore } = require('../../../packages/db/src/stores');
const { start } = require('./service');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const ops = opsStore(db);
const q = (s) => encodeURIComponent(s);

const store = {
  activeTenants: ops.activeTenants,
  connectionsForSweep: ops.connectionsForSweep,
  runExists: async (key) => !!(await db.select('runs', `idempotency_key=eq.${q(key)}&select=id`, { single: true })),
  insertRun: async (row) => { const [r] = await db.insert('runs', [row]); return r; },
  subscriptionFor: async (tenantId) => db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,status&limit=1`, { single: true }),
  lastDeepRunAt: async (tenantId) => {
    const r = await db.select('runs', `tenant_id=eq.${q(tenantId)}&type=eq.deep&select=started_at&order=started_at.desc.nullslast&limit=1`, { single: true });
    return r ? r.started_at : null;
  },
};

const queues = new Map();
const queue = {
  enqueue: async (name, run) => {
    if (!queues.has(name)) queues.set(name, new Queue(name, { connection: { url: required('REDIS_URL') } }));
    await queues.get(name).add('run', { run }, { jobId: `run:${run.tenant_id}:${run.id}` });
  },
};

const sweep = {
  validate: async (conn) => console.log(`token sweep: would validate connection ${conn.id} (Google OAuth client not configured yet)`),
};

start({ store, queue, sweep });

// Email drain — every minute, when the Resend key exists (§12/§17 send loop).
if (process.env.RESEND_API_KEY) {
  const { drainQueuedEmails } = require('../../../packages/emails/src/sender');
  setInterval(() => {
    drainQueuedEmails({ db, apiKey: process.env.RESEND_API_KEY, baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com' })
      .then((r) => { if (r.sent || r.failed) console.log(`emails: sent ${r.sent}, failed ${r.failed}`); })
      .catch((e) => console.error('email drain failed:', e.message));
  }, 60_000);
  console.log('email drain active (1-minute tick)');
} else {
  console.log('email drain idle: no RESEND_API_KEY');
}
// §10.6 learning job — once per calendar month (first tick after the 1st),
// idempotent via learning_reviews(month). Proposes; never applies.
const { runLearningJob } = require('../../../packages/learning/src/job');
async function learningTick() {
  const month = `${new Date().toISOString().slice(0, 7)}-01`;
  const done = await db.select('learning_reviews', `month=eq.${month}&select=month`, { single: true }).catch(() => null);
  if (done) return;
  const r = await runLearningJob({ db, month });
  console.log(`learning job ${month}: ${r.proposals.length} tunings proposed, ${r.backlog.length} backlog items, ${r.carried.length} carried, ${r.rejected.length} refused, ${r.incidents.length} telemetry incidents`);
}
setInterval(() => learningTick().catch((e) => console.error('learning job failed:', e.message)), 6 * 60 * 60_000);
setTimeout(() => learningTick().catch((e) => console.error('learning job failed:', e.message)), 120_000);
console.log('cron running (5-minute tick); learning job monthly');
