const assert = require('node:assert');
const { test } = require('node:test');
const { diffFindings, sinceLastWeekLine } = require('../src/diff');

const now = Date.parse('2026-08-27T00:00:00Z');
const f = (rule_id, entity_key) => ({ rule_id, entity_key, first_seen_run_id: 'r-now' });

test('diff_pass: new vs still-open (first_seen carried, days counted), resolved, superseded', () => {
  const prior = [
    { id: 'p1', rule_id: 'ads.wasted_terms', entity_key: 'wasted_terms', status: 'open', first_seen_run_id: 'r1', first_seen_at: '2026-08-06T00:00:00Z', created_at: '2026-08-20T00:00:00Z' },
    { id: 'p1b', rule_id: 'ads.wasted_terms', entity_key: 'wasted_terms', status: 'open', first_seen_run_id: 'r2', first_seen_at: '2026-08-13T00:00:00Z', created_at: '2026-08-13T00:00:00Z' },
    { id: 'p2', rule_id: 'ga4.retention_short', entity_key: 'retention', status: 'open', first_seen_run_id: 'r1', first_seen_at: '2026-08-06T00:00:00Z', title: 'History deleted early' },
    { id: 'p3', rule_id: 'gtm.legacy_debris', entity_key: 'legacy', status: 'suspect', first_seen_run_id: 'r1', created_at: '2026-08-06T00:00:00Z' },
  ];
  const d = diffFindings({ findings: [f('ads.wasted_terms', 'wasted_terms'), f('ads.dual_primary', 'dual')], prior, now });
  const wasted = d.findings.find((x) => x.rule_id === 'ads.wasted_terms');
  assert.deepStrictEqual({ isNew: wasted.is_new, days: wasted.still_open_days, first: wasted.first_seen_run_id, at: wasted.first_seen_at }, { isNew: false, days: 21, first: 'r1', at: '2026-08-06T00:00:00Z' });
  const dual = d.findings.find((x) => x.rule_id === 'ads.dual_primary');
  assert.deepStrictEqual({ isNew: dual.is_new, days: dual.still_open_days }, { isNew: true, days: 0 });
  assert.deepStrictEqual(d.supersede.sort(), ['p1', 'p1b']);
  assert.deepStrictEqual(d.resolved.map((r) => r.id).sort(), ['p2', 'p3']);
  assert.deepStrictEqual(d.summary, { new: 1, still_open: 1, resolved: 2, longest_open_days: 21 });
  assert.strictEqual(sinceLastWeekLine(d.summary, false), 'Since last week: 2 things from last time are fixed, 1 new, 1 still open (the oldest for 21 days).');
});

test('first run: everything new, no prior', () => {
  const d = diffFindings({ findings: [f('a', 'x')], prior: [], now });
  assert.deepStrictEqual(d.summary, { new: 1, still_open: 0, resolved: 0, longest_open_days: 0 });
  assert.match(sinceLastWeekLine(d.summary, true), /first look/);
  assert.strictEqual(sinceLastWeekLine({ new: 0, still_open: 0, resolved: 0, longest_open_days: 0 }, false), 'Since last week: nothing changed.');
});
