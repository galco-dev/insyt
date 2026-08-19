const assert = require('node:assert');
const { test } = require('node:test');
const { advance, acceleratePoll, pollDelay, dueNudge } = require('../src/tag-install');
const { weeklySlotMinutes, tenantsDueForWeekly, weeklyRunKey, deepAuditDue } = require('../src/scheduling');

const NOW = Date.parse('2026-08-19T10:00:00Z');
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;

test('polling schedule: 2min x15 -> 10min x12 -> 1h x24 -> 6h x28 -> daily', () => {
  assert.strictEqual(pollDelay(0), 2 * MIN);
  assert.strictEqual(pollDelay(14), 2 * MIN);
  assert.strictEqual(pollDelay(15), 10 * MIN);
  assert.strictEqual(pollDelay(27), 1 * HOUR);
  assert.strictEqual(pollDelay(51), 6 * HOUR);
  assert.strictEqual(pollDelay(79), DAY);
  assert.strictEqual(pollDelay(500), DAY, 'daily forever');
});

const freshState = () => ({
  platform: 'wix', guide_issued_at: new Date(NOW).toISOString(),
  poll_count: 0, stage: 'awaiting_install', nudges_sent: [], verified_at: null,
});

test('nothing detected: backoff continues, nudge ladder fires in order, once each', () => {
  let s = freshState();
  let r = advance(s, { container_seen: false }, NOW + 10 * MIN);
  assert.strictEqual(r.effects.length, 0, 'too early for a nudge');
  r = advance(r.state, { container_seen: false }, NOW + 5 * HOUR);
  assert.deepStrictEqual(r.effects, [{ type: 'email', template_id: 'tag_nudge_1' }]);
  r = advance(r.state, { container_seen: false }, NOW + 5 * HOUR + MIN);
  assert.strictEqual(r.effects.length, 0, 'nudge 1 not repeated');
  r = advance(r.state, { container_seen: false }, NOW + 3 * DAY);
  assert.deepStrictEqual(r.effects, [{ type: 'email', template_id: 'tag_nudge_2' }]);
  r = advance(r.state, { container_seen: false }, NOW + 5 * DAY);
  assert.deepStrictEqual(r.effects, [{ type: 'email', template_id: 'tag_nudge_3' }]);
});

test('full green cascade: verified, gate flips, heartbeat watch created, no user confirmation anywhere', () => {
  const r = advance(freshState(), { container_seen: true, collect_fired_correct_id: true, coverage_ok: true, ga4_data_arrived: true }, NOW + HOUR);
  assert.strictEqual(r.state.stage, 'verified');
  assert.ok(r.state.verified_at);
  const types = r.effects.map((e) => e.type + ':' + (e.gate || e.template_id || e.kind));
  assert.deepStrictEqual(types, ['gate:tag', 'email:tag_verified', 'watch:tag_alive']);
});

test('partial cascade: coverage gap routes to the platform corrective', () => {
  const r = advance(freshState(), { container_seen: true, collect_fired_correct_id: true, coverage_ok: false }, NOW + HOUR);
  assert.strictEqual(r.state.stage, 'corrective');
  assert.deepStrictEqual(r.effects, [{ type: 'email', template_id: 'tag_corrective', reason: 'coverage_gap' }]);
});

test('"I\'ve done it" accelerates the next poll and nothing else', () => {
  const s = freshState();
  s.next_poll_at = new Date(NOW + 6 * HOUR).toISOString();
  const s2 = acceleratePoll(s, NOW);
  assert.strictEqual(Date.parse(s2.next_poll_at), NOW);
  assert.strictEqual(s2.stage, s.stage);
});

test('weekly stagger: deterministic slot, only Sunday-window tenants due, stable run key', () => {
  assert.strictEqual(weeklySlotMinutes('tn-abc'), weeklySlotMinutes('tn-abc'));
  const tenants = Array.from({ length: 50 }, (_, i) => ({ id: `tn-${i}` }));
  // Sunday 23 Aug 2026, 20:00 Gulf = 16:00 UTC
  const sundayEvening = Date.parse('2026-08-23T16:00:00Z');
  const due = tenantsDueForWeekly(tenants, sundayEvening);
  assert.ok(due.length > 0 && due.length < 50, `partial batch mid-window (${due.length}/50)`);
  assert.strictEqual(tenantsDueForWeekly(tenants, Date.parse('2026-08-24T16:00:00Z')).length, 0, 'Monday: nothing');
  assert.strictEqual(tenantsDueForWeekly(tenants, Date.parse('2026-08-23T10:00:00Z')).length, 0, 'outside window');
  assert.strictEqual(weeklyRunKey('tn1', sundayEvening), weeklyRunKey('tn1', sundayEvening + HOUR), 'same week same key');
});

test('deep audits: monthly for core, fortnightly for scale', () => {
  assert.strictEqual(deepAuditDue({ tier: 'core' }, null, NOW), true);
  assert.strictEqual(deepAuditDue({ tier: 'core' }, new Date(NOW - 20 * DAY).toISOString(), NOW), false);
  assert.strictEqual(deepAuditDue({ tier: 'scale' }, new Date(NOW - 20 * DAY).toISOString(), NOW), true);
});
