const assert = require('node:assert');
const { test } = require('node:test');
const { rules, computeVolumeDrops } = require('../src/layer3-fire');

const byId = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
const NOW = Date.parse('2026-08-19T00:00:00Z');
const DAY = 86_400_000;
const d = (offset) => new Date(NOW - offset * DAY).toISOString().slice(0, 10);

// Build a daily series: fn(offsetDays) -> count, for offsets 1..days back.
const series = (days, fn) => Array.from({ length: days }, (_, i) => ({ date: d(i + 1), count: fn(i + 1) }));

const gtmWith = (events) => ({
  container_public_id: 'GTM-X',
  triggers: [{ id: '1' }],
  tags: events.map((e, i) => ({ id: `t${i}`, name: `${e} tag`, type: 'gaawe', paused: false, event_name: e, trigger_ids: ['1'] })),
});

test('configured_never_fired: census of silent events with cause hints', () => {
  const gtm = gtmWith(['generate_lead', 'purchase', 'sign_up']);
  gtm.tags[2].trigger_ids = ['99']; // dead trigger → cause hint 'trigger'
  const ga4Data = { window_days: 30, events: [{ event_name: 'generate_lead', total_30d: 40 }] };
  const hits = byId['fire.configured_never_fired'].run({ gtm, ga4Data });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.silent_events, 2);
  const causes = Object.fromEntries(hits[0].payload.entities.map((e) => [e.value, e.likely_cause]));
  assert.strictEqual(causes.purchase, 'tag_or_site');
  assert.strictEqual(causes.sign_up, 'trigger');
});

test('configured_never_fired: silent when everything observed', () => {
  const gtm = gtmWith(['generate_lead']);
  const ga4Data = { events: [{ event_name: 'generate_lead', total_30d: 3 }] };
  assert.strictEqual(byId['fire.configured_never_fired'].run({ gtm, ga4Data }).length, 0);
});

test('event_stopped: silence after sustained volume, publish-date correlation', () => {
  // active until 10 days ago (~5/day), silent since
  const daily = series(40, (off) => (off > 10 ? 5 : 0));
  const ga4Data = { window_days: 40, events: [{ event_name: 'purchase', total_30d: 150, daily }] };
  const th = { quiet_days: 7, min_prior_daily: 1 };
  const correlated = byId['fire.event_stopped'].run({ ga4Data, gtmPublishDates: [d(11)], thresholds: th, now: NOW });
  assert.strictEqual(correlated.length, 1);
  assert.strictEqual(correlated[0].payload.entities[0].correlated_publish, d(11));
  assert.ok(correlated[0].fix, 'correlated breakage proposes restore');
  const uncorrelated = byId['fire.event_stopped'].run({ ga4Data, gtmPublishDates: [d(30)], thresholds: th, now: NOW });
  assert.strictEqual(uncorrelated[0].payload.entities[0].correlated_publish, null);
  assert.strictEqual(uncorrelated[0].fix, undefined, 'uncorrelated → site-side, no restore proposed');
  // still-firing event never flagged
  const alive = { events: [{ event_name: 'x', daily: series(40, () => 2) }] };
  assert.strictEqual(byId['fire.event_stopped'].run({ ga4Data: alive, gtmPublishDates: [], thresholds: th, now: NOW }).length, 0);
});

test('param_integrity: purchase-class events with null value/currency beyond threshold', () => {
  const ga4Data = {
    window_days: 30,
    events: [
      { event_name: 'purchase', total_30d: 90, param_null_pct: { value: 42, currency: 3 } },
      { event_name: 'generate_lead', total_30d: 50, param_null_pct: { value: 100 } }, // not purchase-class
    ],
  };
  const hits = byId['fire.param_integrity'].run({ ga4Data, thresholds: { max_null_pct: 10 } });
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(hits[0].evidence.metrics, { null_value_pct: 42 });
  assert.match(hits[0].payload.fix_detail, /worth/);
});

test('plausibility: outside band flagged both directions, min sessions respected', () => {
  const bands = { generate_lead: { min_per_100_sessions: 1, max_per_100_sessions: 20 } };
  const low = { sessions_30d: 1000, events: [{ event_name: 'generate_lead', total_30d: 2 }] };
  const high = { sessions_30d: 1000, events: [{ event_name: 'generate_lead', total_30d: 400 }] };
  const tiny = { sessions_30d: 50, events: [] };
  assert.match(byId['fire.plausibility'].run({ ga4Data: low, thresholds: { bands } })[0].payload.fix_detail, /less often/);
  assert.match(byId['fire.plausibility'].run({ ga4Data: high, thresholds: { bands } })[0].payload.fix_detail, /implausibly often/);
  assert.strictEqual(byId['fire.plausibility'].run({ ga4Data: tiny, thresholds: { bands } }).length, 0);
});

test('volume_anomaly: severity scales with magnitude; full silence left to event_stopped', () => {
  const drop90 = series(40, (off) => (off <= 7 ? 1 : 10)); // ~90% down but not silent
  const drop60 = series(40, (off) => (off <= 7 ? 4 : 10));
  const silent = series(40, (off) => (off <= 7 ? 0 : 10));
  const th = { critical_drop_pct: 80, warning_drop_pct: 50, min_baseline_daily: 3 };
  const run = (daily) => byId['fire.volume_anomaly'].run({ ga4Data: { events: [{ event_name: 'e', daily }] }, thresholds: th, now: NOW });
  assert.strictEqual(run(drop90)[0].severity_override, 'critical');
  assert.strictEqual(run(drop60)[0].severity_override, 'warning');
  assert.strictEqual(run(silent).length, 0);
  assert.strictEqual(run(series(40, () => 10)).length, 0, 'steady volume clean');
});

test('computeVolumeDrops: the Layer 1 join emits drops with breakpoint dates', () => {
  const daily = series(40, (off) => (off <= 9 ? 0 : 8));
  const drops = computeVolumeDrops({ events: [{ event_name: 'purchase', daily }] }, { min_drop_pct: 50, min_baseline_daily: 1 }, NOW);
  assert.strictEqual(drops.length, 1);
  assert.strictEqual(drops[0].event_name, 'purchase');
  assert.ok(drops[0].drop_pct >= 90);
  assert.strictEqual(drops[0].breakpoint_date, d(10));
});
