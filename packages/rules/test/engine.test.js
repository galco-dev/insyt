const assert = require('node:assert');
const { test } = require('node:test');
const { runRules, healthScore } = require('../src/engine');
const { sortWeight } = require('../src/sort-weight');

const CONFIG = {
  'test.always': { default_severity: 'warning', thresholds: {}, fix_tool_id: 'ads.pause_campaign', enabled: true },
  'test.disabled': { default_severity: 'critical', thresholds: {}, enabled: false },
  'test.throws': { default_severity: 'info', thresholds: {}, enabled: true },
};

const RULES = [
  {
    rule_id: 'test.always',
    layer: 4,
    run: () => [{
      category: 'wasted_spend',
      entity_key: 'campaign:1',
      money: { impact_monthly_usd: 340, confidence: 'measured' },
      evidence: { metrics: { x: 1 }, window_days: 90, queries: [] },
      payload: { entities: [{ kind: 'campaign', value: 'Brand' }], fix_detail: 'pause it' },
      fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
    }],
  },
  { rule_id: 'test.disabled', layer: 1, run: () => [{ category: 'x', entity_key: 'y' }] },
  { rule_id: 'test.throws', layer: 1, run: () => { throw new Error('api fell over'); } },
];

test('engine: decorates findings from config, skips disabled, captures rule errors', () => {
  const { findings, errors, counts } = runRules({
    rules: RULES, ruleConfig: CONFIG, ctx: {}, runId: 'r1', tenantId: 'tn1',
  });
  assert.strictEqual(findings.length, 1);
  const f = findings[0];
  assert.strictEqual(f.severity, 'warning');
  assert.strictEqual(f.fix.tool_id, 'ads.pause_campaign');
  assert.strictEqual(f.first_seen_run_id, 'r1');
  assert.strictEqual(f.title, null, 'narration writes title, never the engine');
  assert.strictEqual(f.display.sort_weight, sortWeight('warning', 340));
  assert.deepStrictEqual(counts, { critical: 0, warning: 1, opportunity: 0, info: 0 });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].rule_id, 'test.throws');
});

test('engine: dedupe keeps first_seen_run_id across runs', () => {
  const prior = [{ rule_id: 'test.always', entity_key: 'campaign:1', first_seen_run_id: 'r0', status: 'open' }];
  const { findings } = runRules({
    rules: RULES, ruleConfig: CONFIG, ctx: {}, priorFindings: prior, runId: 'r2', tenantId: 'tn1',
  });
  assert.strictEqual(findings[0].first_seen_run_id, 'r0');
  assert.strictEqual(findings[0].status, 'open');
});

test('engine: suspect findings return suspect with fix suppressed (§2.2)', () => {
  const prior = [{ rule_id: 'test.always', entity_key: 'campaign:1', first_seen_run_id: 'r0', status: 'suspect' }];
  const { findings } = runRules({
    rules: RULES, ruleConfig: CONFIG, ctx: {}, priorFindings: prior, runId: 'r3', tenantId: 'tn1',
  });
  assert.strictEqual(findings[0].status, 'suspect');
  assert.strictEqual(findings[0].fix.available, false, 'identical fix never re-proposed while suspect');
});

test('healthScore: deterministic §13 formula, capped and clamped', () => {
  const f = (severity, status = 'open') => ({ severity, status });
  assert.strictEqual(healthScore([]), 100);
  assert.strictEqual(healthScore([f('critical'), f('warning'), f('warning')]), 75);
  assert.strictEqual(healthScore([f('critical'), f('critical'), f('resolved')]), 70);
  assert.strictEqual(healthScore(Array.from({ length: 10 }, () => f('critical'))), 15, 'penalties cap at 85');
  assert.strictEqual(healthScore([f('critical')], 10), 95);
  assert.strictEqual(healthScore([], 10), 100, 'clamped to 100');
});

test('engine + layer1 integration: full container snapshot produces sorted findings', () => {
  const { rules: l1 } = require('../src/layer1-gtm');
  const ruleConfig = {
    'gtm.duplicate_ga4_tags': { default_severity: 'critical', thresholds: {}, fix_tool_id: 'gtm.pause_tag', enabled: true },
    'gtm.orphan_tags': { default_severity: 'info', thresholds: {}, fix_tool_id: null, enabled: true },
    'gtm.id_mismatch': { default_severity: 'critical', thresholds: {}, fix_tool_id: 'gtm.update_tag_config', enabled: true },
    'gtm.legacy_debris': { default_severity: 'warning', thresholds: {}, fix_tool_id: 'gtm.pause_tag', enabled: true },
    'gtm.consent_mode_absent': { default_severity: 'warning', thresholds: {}, fix_tool_id: null, enabled: true },
    'gtm.unpublished_changes': { default_severity: 'info', thresholds: { stale_days: 7 }, fix_tool_id: 'gtm.publish', enabled: true },
    'gtm.version_regression': { default_severity: 'critical', thresholds: {}, fix_tool_id: 'gtm.restore_version_element', enabled: true },
  };
  const gtm = {
    container_public_id: 'GTM-TEST123',
    tags: [
      { id: 't1', name: 'GA4 A', type: 'gaawc', paused: false, measurement_id: 'G-DUP0000001', trigger_ids: ['1'] },
      { id: 't2', name: 'GA4 B', type: 'gaawc', paused: false, measurement_id: 'G-DUP0000001', trigger_ids: ['1'] },
      { id: 't3', name: 'Old UA', type: 'ua', paused: false, measurement_id: 'UA-1-1', trigger_ids: ['1'] },
      { id: 't4', name: 'Orphan', type: 'html', paused: false, trigger_ids: [] },
    ],
    triggers: [{ id: '1', name: 'All Pages', type: 'pageview' }],
    workspace_changes: [],
    versions: null,
  };
  const { findings, errors, counts } = runRules({
    rules: l1, ruleConfig,
    ctx: { gtm, linkedMeasurementIds: ['G-DUP0000001'], servesEuUk: false, eventVolumeDrops: [], now: Date.parse('2026-08-19T00:00:00Z') },
    runId: 'r1', tenantId: 'tn1',
  });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(counts, { critical: 1, warning: 1, opportunity: 0, info: 1 });
  assert.strictEqual(findings[0].rule_id, 'gtm.duplicate_ga4_tags', 'critical sorts first');
  assert.ok(findings.every((f) => f.schema_version === 1));
});
