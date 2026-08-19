const assert = require('node:assert');
const { test } = require('node:test');
const { rules } = require('../src/layer5-live');

const byId = Object.fromEntries(rules.map((r) => [r.rule_id, r]));

const gtm = { container_public_id: 'GTM-TEST123' };
const page = (url, opts = {}) => ({
  url, ok: true, is_homepage: !!opts.home,
  gtm_containers_seen: opts.gtm || [], collect_measurement_ids: opts.collect || [],
});

test('container_missing: config exists, no rendered page loads it', () => {
  const witness = { pages: [page('/', { home: true }), page('/contact')] };
  const hits = byId['live.container_missing'].run({ witness, gtm });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.pages_with_container, 0);
  const present = { pages: [page('/', { home: true, gtm: ['GTM-TEST123'] })] };
  assert.strictEqual(byId['live.container_missing'].run({ witness: present, gtm }).length, 0);
});

test('collect_wrong_id: only unexpected measurement IDs flagged', () => {
  const witness = { pages: [page('/', { home: true, collect: ['G-RIGHT00001', 'G-ROGUE00001'] })] };
  const hits = byId['live.collect_wrong_id'].run({ witness, linkedMeasurementIds: ['G-RIGHT00001'] });
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(hits[0].payload.entities, [{ kind: 'measurement_id', value: 'G-ROGUE00001' }]);
  assert.strictEqual(byId['live.collect_wrong_id'].run({ witness, linkedMeasurementIds: [] }).length, 0, 'nothing linked — no comparison');
});

test('coverage_gap: homepage tagged, key pages not; fully-missing defers to container_missing', () => {
  const witness = {
    pages: [
      page('/', { home: true, gtm: ['GTM-TEST123'] }),
      page('/services', { gtm: ['GTM-TEST123'] }),
      page('/booking'),
      page('/contact'),
    ],
  };
  const hits = byId['live.coverage_gap'].run({ witness, gtm });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.pages_missing, 2);
  const bare = { pages: [page('/', { home: true }), page('/contact')] };
  assert.strictEqual(byId['live.coverage_gap'].run({ witness: bare, gtm }).length, 0);
});

test('tag_alive: fires only after a prior verification, unlocked (alerts never paywalled)', () => {
  const dead = { pages: [page('/', { home: true }), page('/contact')] };
  assert.strictEqual(byId['live.tag_alive'].run({ witness: dead, gtm, previouslyVerified: false }).length, 0);
  const hits = byId['live.tag_alive'].run({ witness: dead, gtm, previouslyVerified: true });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].payload.locked, false);
  const alive = { pages: [page('/', { home: true, gtm: ['GTM-TEST123'] })] };
  assert.strictEqual(byId['live.tag_alive'].run({ witness: alive, gtm, previouslyVerified: true }).length, 0);
});
