const assert = require('node:assert');
const { test } = require('node:test');
const { rules } = require('../src/layer1-gtm');

const byId = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
const NOW = Date.parse('2026-08-19T00:00:00Z');

const baseGtm = () => ({
  container_public_id: 'GTM-TEST123',
  tags: [],
  triggers: [{ id: '1', name: 'All Pages', type: 'pageview' }],
  workspace_changes: [],
  versions: null,
});

test('duplicate_ga4_tags: same G-ID, overlapping trigger → hit; disjoint triggers → clean', () => {
  const gtm = baseGtm();
  gtm.tags = [
    { id: 't1', name: 'GA4 A', type: 'gaawc', paused: false, measurement_id: 'G-AAA111AAA', trigger_ids: ['1'] },
    { id: 't2', name: 'GA4 B', type: 'gaawc', paused: false, measurement_id: 'G-AAA111AAA', trigger_ids: ['1'] },
  ];
  const hits = byId['gtm.duplicate_ga4_tags'].run({ gtm });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.duplicate_tag_count, 2);

  gtm.tags[1].trigger_ids = ['2'];
  assert.strictEqual(byId['gtm.duplicate_ga4_tags'].run({ gtm }).length, 0);

  gtm.tags[1].trigger_ids = ['1'];
  gtm.tags[1].paused = true; // paused duplicate is not double-counting
  assert.strictEqual(byId['gtm.duplicate_ga4_tags'].run({ gtm }).length, 0);
});

test('orphan_tags: no trigger, or all trigger refs dead', () => {
  const gtm = baseGtm();
  gtm.tags = [
    { id: 't1', name: 'No trigger', type: 'html', paused: false, trigger_ids: [] },
    { id: 't2', name: 'Dead ref', type: 'html', paused: false, trigger_ids: ['99'] },
    { id: 't3', name: 'Healthy', type: 'html', paused: false, trigger_ids: ['1'] },
    { id: 't4', name: 'Partial', type: 'html', paused: false, trigger_ids: ['1', '99'] },
  ];
  const keys = byId['gtm.orphan_tags'].run({ gtm }).map((h) => h.entity_key).sort();
  assert.deepStrictEqual(keys, ['t1', 't2']);
});

test('id_mismatch: fires only when a linked property exists to compare against', () => {
  const gtm = baseGtm();
  gtm.tags = [{ id: 't1', name: 'GA4', type: 'gaawc', paused: false, measurement_id: 'G-WRONG00001', trigger_ids: ['1'] }];
  assert.strictEqual(byId['gtm.id_mismatch'].run({ gtm, linkedMeasurementIds: [] }).length, 0);
  const hits = byId['gtm.id_mismatch'].run({ gtm, linkedMeasurementIds: ['G-RIGHT00001'] });
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0].payload.fix_detail, /G-WRONG00001/);
});

test('legacy_debris: active UA tags collapse into one finding; paused ignored', () => {
  const gtm = baseGtm();
  gtm.tags = [
    { id: 't1', name: 'Old UA', type: 'ua', paused: false, measurement_id: 'UA-123-1', trigger_ids: ['1'] },
    { id: 't2', name: 'Old UA 2', type: 'ua', paused: false, measurement_id: 'UA-123-2', trigger_ids: ['1'] },
    { id: 't3', name: 'Parked UA', type: 'ua', paused: true, trigger_ids: ['1'] },
  ];
  const hits = byId['gtm.legacy_debris'].run({ gtm });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.legacy_tag_count, 2);
});

test('consent_mode_absent: EU/UK-serving site without consent config', () => {
  const gtm = baseGtm();
  gtm.tags = [{ id: 't1', name: 'GA4', type: 'gaawc', paused: false, trigger_ids: ['1'] }];
  assert.strictEqual(byId['gtm.consent_mode_absent'].run({ gtm, servesEuUk: false }).length, 0);
  assert.strictEqual(byId['gtm.consent_mode_absent'].run({ gtm, servesEuUk: true }).length, 1);
  gtm.tags[0].consent_settings = { status: 'set' };
  assert.strictEqual(byId['gtm.consent_mode_absent'].run({ gtm, servesEuUk: true }).length, 0);
});

test('unpublished_changes: stale beyond threshold only', () => {
  const gtm = baseGtm();
  gtm.workspace_changes = [{ change_type: 'update', entity: 'tag:GA4', changed_at: '2026-08-01T00:00:00Z' }];
  const hits = byId['gtm.unpublished_changes'].run({ gtm, now: NOW, thresholds: { stale_days: 7 } });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.oldest_change_age_days, 18);
  const fresh = byId['gtm.unpublished_changes'].run({ gtm, now: Date.parse('2026-08-05T00:00:00Z'), thresholds: { stale_days: 7 } });
  assert.strictEqual(fresh.length, 0);
});

test('version_regression: deleted tag + correlated event drop → hit; no drop → silent', () => {
  const gtm = baseGtm();
  gtm.versions = {
    latest: { version_id: 9, created_at: '2026-08-10T00:00:00Z', tags: [] },
    previous: { version_id: 8, tags: [{ id: 't5', name: 'Purchase tag', paused: false, event_name: 'purchase' }] },
  };
  const drops = [{ event_name: 'purchase', drop_pct: 96, breakpoint_date: '2026-08-10' }];
  const hits = byId['gtm.version_regression'].run({ gtm, eventVolumeDrops: drops });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.max_drop_pct, 96);
  assert.strictEqual(byId['gtm.version_regression'].run({ gtm, eventVolumeDrops: [] }).length, 0);
  assert.strictEqual(byId['gtm.version_regression'].run({ gtm, eventVolumeDrops: [{ event_name: 'lead', drop_pct: 80 }] }).length, 0);
});
