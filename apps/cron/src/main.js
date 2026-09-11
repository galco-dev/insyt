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
  resumeDue: ops.resumeDue,
  weeklyCadence: ops.weeklyCadence,
  activatePendingAgencyAccounts: ops.activatePendingAgencyAccounts,
  connectionsForSweep: ops.connectionsForSweep,
  runExists: async (key) => !!(await db.select('runs', `idempotency_key=eq.${q(key)}&select=id`, { single: true })),
  // Active tenants with at least one linked asset and no completed or in-flight run.
  signupAuditCandidates: async () => {
    const tenants = await db.select('tenants', 'select=id&status=eq.active');
    const out = [];
    for (const t of tenants) {
      const linked = await db.select('assets', `tenant_id=eq.${q(t.id)}&linked=eq.true&select=id&limit=1`, { single: true });
      if (!linked) continue;
      const done = await db.select('runs', `tenant_id=eq.${q(t.id)}&status=in.(complete,degraded,queued,running)&select=id&limit=1`, { single: true });
      if (done) continue;
      out.push(t);
    }
    return out;
  },
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

// The sweep, for real (fix plan move 10): refresh each due connection's
// token (the client marks it expired or revoked and ledgers it on failure),
// email a one-tap reconnect once per lapse, and look again for accounts.
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
let sweep = {
  validate: async (conn) => { console.log(`token sweep: would validate connection ${conn.id} (Google OAuth client not configured yet)`); return false; },
};
if (googleClientId && googleClientSecret) {
  const { createGoogleAuth } = require('../../../packages/google/src/client');
  const { rediscoverTenant } = require('../../../packages/google/src/discovery-store');
  const auth = createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret });
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3315824995';
  const tenantOf = async (conn) => {
    const u = await db.select('users', `id=eq.${q(conn.user_id)}&select=tenant_id,email`, { single: true }).catch(() => null);
    return u || null;
  };
  sweep = {
    validate: async (conn) => {
      const u = await tenantOf(conn);
      if (!u) return false;
      try {
        await auth.accessToken(u.tenant_id);
        return true;
      } catch (e) {
        // The client already moved the status and wrote the ledger line; one email per lapse.
        const recent = await db.select('emails', `tenant_id=eq.${q(u.tenant_id)}&template_id=eq.reconnect_needed&created_at=gte.${q(new Date(Date.now() - 7 * 86_400_000).toISOString())}&select=id&limit=1`, { single: true }).catch(() => null);
        if (!recent && u.email) {
          await db.insert('emails', [{ tenant_id: u.tenant_id, template_id: 'reconnect_needed', to_email: u.email, stream: 'transactional', status: 'queued', payload: { reconnect_url: `${process.env.APP_BASE_URL || 'https://app.tryinsyt.com'}/auth/google/start?step=discovery` } }], { returning: false }).catch(() => {});
        }
        console.log(`token sweep: connection ${conn.id} lapsed (${e.message.slice(0, 80)})`);
        return false;
      }
    },
    rediscover: async (conn) => {
      const u = await tenantOf(conn);
      if (!u) return null;
      const r = await rediscoverTenant({ db, auth, developerToken, loginCustomerId, tenantId: u.tenant_id });
      if (r.inserted) console.log(`rediscover: ${r.inserted} new asset(s) for ${u.tenant_id}, ${r.matched} matched`);
      return r;
    },
  };
}

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
