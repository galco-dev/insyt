// Railway `worker` service entrypoint — build-doc §8, §15.
// BullMQ consumer over Redis; per-tenant lock via BullMQ job ids (one run at
// a time per tenant). BullMQ is lazy-required so the pipeline itself (and
// CI) never needs Redis — this file is only exercised on Railway.
//
// Env: REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY, …

const { runPipeline } = require('./pipeline');
const { buildStages } = require('./stages');

const QUEUES = {
  signup: { name: 'runs-signup', priority: 1 },   // immediate priority queue (§8)
  weekly: { name: 'runs-weekly', priority: 5 },
  triggered: { name: 'runs-triggered', priority: 3 },
};

function tenantJobId(tenantId, runId) {
  // BullMQ dedupes on job id → a tenant's run is queued at most once.
  return `run:${tenantId}:${runId}`;
}

async function start({ clients, store, redisUrl = process.env.REDIS_URL }) {
  // Lazy: bullmq only loads on the real service.
  // eslint-disable-next-line global-require
  const { Worker } = require('bullmq');
  const connection = { url: redisUrl };
  const stages = buildStages(clients);

  const process_ = async (job) => {
    const run = job.data.run;
    return runPipeline({
      run,
      stages,
      store,
      emit: (e) => job.updateProgress(e).catch(() => {}), // SSE bridge reads job progress
    });
  };

  const workers = Object.values(QUEUES).map((q) => new Worker(q.name, process_, { connection, concurrency: 2 }));
  return { workers, stop: () => Promise.all(workers.map((w) => w.close())) };
}

module.exports = { start, QUEUES, tenantJobId };

if (require.main === module) {
  // Real service bootstrap happens here once Railway env exists; clients and
  // store implementations are the deploy-phase wiring.
  console.error('worker service: supply clients/store wiring before running standalone');
  process.exit(1);
}
