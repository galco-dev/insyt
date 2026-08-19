const assert = require('node:assert');
const { test } = require('node:test');
const { rules } = require('../src/layer2-ga4');

const byId = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
const NOW = Date.parse('2026-08-19T00:00:00Z');

const baseGa4 = () => ({
  property_id: '333222111',
  key_events: [{ name: 'ke1', event_name: 'generate_lead', counting_method: 'ONCE_PER_EVENT', create_time: '2026-01-01T00:00:00Z' }],
  ads_links: [{ customer_id: '6424596144', create_time: '2026-01-01T00:00:00Z' }],
  retention_months: 14,
  enhanced_measurement: { enabled: true, events: ['page_view', 'scroll'] },
  attribution: { model: 'data_driven', is_default: true, changed_at: null },
});

test('no_key_events: fires only on an empty key-event list', () => {
  const ga4 = baseGa4();
  assert.strictEqual(byId['ga4.no_key_events'].run({ ga4 }).length, 0);
  ga4.key_events = [];
  const hits = byId['ga4.no_key_events'].run({ ga4 });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.key_event_count, 0);
});

test('key_event_wrong: non-business events flagged, business events pass', () => {
  const ga4 = baseGa4();
  ga4.key_events = [
    { name: 'ke1', event_name: 'page_view' },
    { name: 'ke2', event_name: 'purchase' },
    { name: 'ke3', event_name: 'session_start' },
  ];
  const keys = byId['ga4.key_event_wrong'].run({ ga4 }).map((h) => h.entity_key);
  assert.deepStrictEqual(keys, ['333222111:page_view', '333222111:session_start']);
});

test('ads_link_missing: needs a confirmed Ads account AND no link', () => {
  const ga4 = baseGa4();
  ga4.ads_links = [];
  assert.strictEqual(byId['ga4.ads_link_missing'].run({ ga4, linkedAdsCustomerIds: [] }).length, 0, 'no ads account — Journey B/C ground, not a finding');
  assert.strictEqual(byId['ga4.ads_link_missing'].run({ ga4, linkedAdsCustomerIds: ['6424596144'] }).length, 1);
  ga4.ads_links = [{ customer_id: '6424596144', create_time: '2026-01-01T00:00:00Z' }];
  assert.strictEqual(byId['ga4.ads_link_missing'].run({ ga4, linkedAdsCustomerIds: ['6424596144'] }).length, 0);
});

test('ads_link_recent: inside the conversion window only, unlocked context', () => {
  const ga4 = baseGa4();
  ga4.ads_links = [{ customer_id: '111', create_time: '2026-08-10T00:00:00Z' }];
  const hits = byId['ga4.ads_link_recent'].run({ ga4, conversionWindowDays: 30, now: NOW });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.link_age_days, 9);
  assert.strictEqual(hits[0].payload.locked, false);
  const old = byId['ga4.ads_link_recent'].run({ ga4: baseGa4(), conversionWindowDays: 30, now: NOW });
  assert.strictEqual(old.length, 0);
});

test('retention_short: 2 months flagged, 14 clean', () => {
  const ga4 = baseGa4();
  ga4.retention_months = 2;
  const hits = byId['ga4.retention_short'].run({ ga4 });
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0].payload.fix_detail, /14 months/);
  assert.strictEqual(byId['ga4.retention_short'].run({ ga4: baseGa4() }).length, 0);
});

test('enhanced_double_fire: GTM GA4-event tag overlapping enhanced measurement', () => {
  const ga4 = baseGa4();
  const gtm = {
    tags: [
      { id: 't1', name: 'Scroll tag', type: 'gaawe', paused: false, event_name: 'scroll' },
      { id: 't2', name: 'Lead tag', type: 'gaawe', paused: false, event_name: 'generate_lead' },
      { id: 't3', name: 'Paused dup', type: 'gaawe', paused: true, event_name: 'page_view' },
    ],
  };
  const hits = byId['ga4.enhanced_double_fire'].run({ ga4, gtm });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.double_fired_events, 1);
  assert.deepStrictEqual(hits[0].payload.entities[0].value, 'scroll');
  ga4.enhanced_measurement.enabled = false;
  assert.strictEqual(byId['ga4.enhanced_double_fire'].run({ ga4, gtm }).length, 0);
});

test('attribution_nonstandard: old non-default flagged as unlocked context; recent change respected', () => {
  const ga4 = baseGa4();
  ga4.attribution = { model: 'last_click', is_default: false, changed_at: '2025-09-01T00:00:00Z' };
  const hits = byId['ga4.attribution_nonstandard'].run({ ga4, thresholds: {}, now: NOW });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].payload.locked, false);
  ga4.attribution.changed_at = '2026-08-01T00:00:00Z';
  assert.strictEqual(byId['ga4.attribution_nonstandard'].run({ ga4, thresholds: {}, now: NOW }).length, 0);
  assert.strictEqual(byId['ga4.attribution_nonstandard'].run({ ga4: baseGa4(), thresholds: {}, now: NOW }).length, 0);
});
