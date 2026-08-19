// Railway `cron` service — build-doc §8, §15.
// One loop, four duties: Sunday-night weekly enqueue (tenant-hash staggered),
// deep-audit anniversaries, weekly token-validation sweep, staleness checks.
// All logic lives in packages/journeys + packages/google; this service is the
// clock. Everything injected for tests; tick() is the unit under test.

const { tenantsDueForWeekly, weeklyRunKey, deepAuditDue } = require('../../../packages/journeys/src/scheduling');
const { dueForValidation } = require('../../../packages/google/src/connection-state');

const TICK_MS = 5 * 60_000; // five-minute clock; all duties are idempotent

/**
 * One tick. deps:
 *   store: opsStore + { subscriptionFor(tenantId), lastDeepRunAt(tenantId),
 *                       runExists(idempotencyKey), insertRun(row) }
 *   queue: { enqueue(queueName, run) }
 *   sweep: { validate(connection) }  — google validation probe
 */
async function tick({ store, queue, sweep, now = Date.now() }) {
  const actions = { weekly: 0, deep: 0, swept: 0 };
  const tenants = await store.activeTenants();

  // 1. Weekly runs — Sunday window, hash-staggered, one per tenant per ISO week.
  for (const t of tenantsDueForWeekly(tenants, now)) {
    const key = weeklyRunKey(t.id, now);
    if (await store.runExists(key)) continue;
    const run = await store.insertRun({ tenant_id: t.id, type: 'weekly', status: 'queued', idempotency_key: key });
    await queue.enqueue('runs-weekly', run);
    actions.weekly += 1;
  }

  // 2. Deep-audit anniversaries (monthly; fortnightly on Scale).
  for (const t of tenants) {
    const sub = await store.subscriptionFor(t.id);
    if (!sub || !['active', 'past_due'].includes(sub.status)) continue;
    const lastDeep = await store.lastDeepRunAt(t.id);
    if (!deepAuditDue(sub, lastDeep, now)) continue;
    const key = `deep:${t.id}:${new Date(now).toISOString().slice(0, 10)}`;
    if (await store.runExists(key)) continue;
    const run = await store.insertRun({ tenant_id: t.id, type: 'deep', status: 'queued', idempotency_key: key });
    await queue.enqueue('runs-weekly', run);
    actions.deep += 1;
  }

  // 3. Token validation sweep — weekly per connection, proactive (§6).
  const conns = await store.connectionsForSweep();
  for (const conn of dueForValidation(conns, now)) {
    await sweep.validate(conn); // sweep handles transitions + reconnect emails
    actions.swept += 1;
  }

  return actions;
}

function start(deps) {
  const timer = setInterval(() => {
    tick(deps).catch((err) => console.error('cron tick failed:', err.message));
  }, TICK_MS);
  return { stop: () => clearInterval(timer) };
}

module.exports = { tick, start, TICK_MS };

if (require.main === module) {
  console.error('cron service: supply store/queue/sweep wiring before running standalone');
  process.exit(1);
}
