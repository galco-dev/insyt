// "Against your goals" report section — renders only with targets set,
// plain language, correct on-target/needs-work verdicts.
const assert = require('node:assert');
const { test } = require('node:test');
const { renderPerformanceSection } = require('../src/performance');
const { assembleEnvelope } = require('../src/envelope');
const { renderReport, TOKENS } = require('../src/render');

const run = { id: 'r1', type: 'weekly', status: 'complete' };

test('no targets → empty string; section absent from report', () => {
  assert.strictEqual(renderPerformanceSection({ spend_usd: 500, targets: {} }, TOKENS), '');
  const env = assembleEnvelope({ run, findings: [], ledgerCumulative: null, narrativeSlots: {} });
  assert.strictEqual(env.performance, undefined);
  assert.ok(!renderReport(env).includes('Against your goals'));
});

test('budget + CPA + ROAS rows with verdicts', () => {
  const html = renderPerformanceSection({
    month_label: 'August',
    spend_usd: 2960, conversions: 57.7, conversion_value_usd: 9400,
    targets: { monthly_budget_usd: 3900, cpa_target_usd: 45, roas_target: 4 },
    pacing: { projected: 4588, deltaPct: 17.6, status: 'over' },
  }, TOKENS);
  assert.ok(html.includes('Against your goals — August'));
  assert.ok(html.includes('Spend vs plan'));
  assert.ok(html.includes('heading for $4,588'));
  assert.ok(html.includes('Running hot'));
  // CPA 2960/57.7 = 51.3 vs 45 target → needs work
  assert.ok(html.includes('Cost per result'));
  assert.ok(html.includes('needs work'));
  // ROAS 9400/2960 = 3.18× vs 4× target*0.9=3.6 → below goal
  assert.ok(html.includes('3.2× back'));
  // No client-fee vocabulary, ever.
  assert.ok(!/fee|invoice|bill/i.test(html));
});

test('hitting targets reads on-target; envelope wires section into the report', () => {
  const performance = {
    spend_usd: 1230, conversions: 30, conversion_value_usd: 4230,
    targets: { monthly_budget_usd: 1900, cpa_target_usd: 45, roas_target: 3.2 },
    pacing: { projected: 1907, deltaPct: 0.4, status: 'on_pace' },
  };
  const html = renderPerformanceSection(performance, TOKENS);
  assert.ok(html.includes('on target'));
  assert.ok(html.includes('On plan.'));
  assert.ok(html.includes('3.4× back'));

  const env = assembleEnvelope({ run, findings: [], ledgerCumulative: null, narrativeSlots: {}, performance });
  const report = renderReport(env, { mode: 'web' });
  assert.ok(report.includes('Against your goals'));
});
