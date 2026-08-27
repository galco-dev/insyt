const assert = require('node:assert');
const { test } = require('node:test');
const { runRules } = require('../src/engine');
const { rules } = require('../src/journey');
const cfg = { 'journeyB.setup_incomplete': { enabled: true, default_severity: 'warning', thresholds: {} } };

test('journeyB.setup_incomplete: lists the steps left with who does them; silent for Journey A or when complete', () => {
  const { findings } = runRules({ rules, ruleConfig: cfg, runId: 'r', tenantId: 't', ctx: { setup: { journey: 'B', gates: { tag: false, billing: false }, linked: ['ads_account', 'gtm_container'] } } });
  assert.strictEqual(findings.length, 1);
  const steps = findings[0].payload.entities;
  assert.deepStrictEqual(steps.map((s) => [s.value, s.by]), [['Visit tracking', 'insyt'], ['Tracking code seen live', 'insyt'], ['Ad money connected to Google', 'you']]);
  assert.match(findings[0].payload.fix_detail, /We do 2 of them/);
  assert.strictEqual(runRules({ rules, ruleConfig: cfg, runId: 'r', tenantId: 't', ctx: { setup: { journey: 'A', gates: {}, linked: [] } } }).findings.length, 0);
  assert.strictEqual(runRules({ rules, ruleConfig: cfg, runId: 'r', tenantId: 't', ctx: { setup: { journey: 'B', gates: { tag: true, billing: true }, linked: ['ga4_property', 'gtm_container'] } } }).findings.length, 0);
});
