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
console.log('cron running (5-minute tick)');
