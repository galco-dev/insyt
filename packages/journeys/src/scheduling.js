// Scheduling helpers — build-doc §8, §15.
// Sunday-night weekly runs staggered 18:00–23:00 Gulf by tenant hash, so no
// thundering herd on the GTM API budget. Deep audits on anniversaries.

const crypto = require('crypto');

const WINDOW_START_HOUR = 18; // Gulf time (UTC+4)
const WINDOW_HOURS = 5;       // 18:00–23:00

/** Deterministic per-tenant minute offset inside the Sunday window. */
function weeklySlotMinutes(tenantId) {
  const h = crypto.createHash('sha256').update(String(tenantId)).digest();
  return h.readUInt32BE(0) % (WINDOW_HOURS * 60);
}

/**
 * The Sunday-evening enqueue: which tenants are due at `now` (ms epoch)?
 * Called every few minutes by the cron service; idempotency is the run's
 * idempotency_key (tenant + ISO week), enforced at insert.
 */
function tenantsDueForWeekly(tenants, now, tzOffsetHours = 4) {
  const local = new Date(now + tzOffsetHours * 3_600_000);
  if (local.getUTCDay() !== 0) return []; // Sunday in Gulf time
  const minutesIntoWindow = (local.getUTCHours() - WINDOW_START_HOUR) * 60 + local.getUTCMinutes();
  if (minutesIntoWindow < 0 || minutesIntoWindow >= WINDOW_HOURS * 60) return [];
  return tenants.filter((t) => weeklySlotMinutes(t.id) <= minutesIntoWindow);
}

/** Idempotency key for a weekly run: one per tenant per ISO week. */
function weeklyRunKey(tenantId, now) {
  const d = new Date(now);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((now - jan1) / 86_400_000 + new Date(jan1).getUTCDay() + 1) / 7);
  return `weekly:${tenantId}:${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Deep-audit anniversaries: monthly (Core/Autopilot) or fortnightly (Scale). */
function deepAuditDue(subscription, lastDeepAt, now) {
  const interval = subscription.tier === 'scale' ? 14 : 30;
  if (!lastDeepAt) return true;
  return (now - Date.parse(lastDeepAt)) / 86_400_000 >= interval;
}

module.exports = { weeklySlotMinutes, tenantsDueForWeekly, weeklyRunKey, deepAuditDue, WINDOW_START_HOUR, WINDOW_HOURS };
