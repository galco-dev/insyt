const assert = require('node:assert');
const { test } = require('node:test');
const { assembleEnvelope } = require('../src/envelope');
const { narrationInput, numbersAreGrounded, narrateFinding } = require('../src/narration');
const { renderReport } = require('../src/render');

const finding = (over = {}) => ({
  schema_version: 1, run_id: 'r1', tenant_id: 'tn1',
  rule_id: 'ads.wasted_terms', layer: 4, severity: 'warning', status: 'open',
  category: 'wasted_spend', entity_key: 'wasted_terms', first_seen_run_id: 'r1',
  title: '43 search terms are wasting money',
  explanation: 'About $340 a month is going to clicks that cannot become customers.',
  money: { impact_monthly_usd: 340, impact_monthly_local: { amount: 1249, currency: 'AED' }, direction: 'waste', confidence: 'measured' },
  evidence: { metrics: { term_count: 43, spend_90d_usd: 1020 }, window_days: 90, queries: [] },
  payload: {
    locked: true,
    entities: [{ kind: 'search_term', value: 'free nail course', spend_usd: 41.2, clicks: 38 }],
    fix_detail: 'Add 43 negative keywords at campaign level; list attached.',
  },
  fix: { available: true, tool_id: 'ads.add_negative_keywords', params_ref: 'x', risk: 'low', reversible: true, approval_scope: 'change' },
  display: { icon: 'trending-down', badge_color: 'warning', sort_weight: 73 },
  ...over,
});

test('envelope: counts, waste sum over open waste findings, sorted output', () => {
  const f1 = finding();
  const f2 = finding({ severity: 'critical', money: { impact_monthly_usd: 200, direction: 'waste', confidence: 'estimated' }, display: { sort_weight: 88 }, status: 'open' });
  const f3 = finding({ status: 'applied', money: { impact_monthly_usd: 999, direction: 'waste', confidence: 'measured' }, display: { sort_weight: 10 } });
  const env = assembleEnvelope({
    run: { id: 'r1', type: 'weekly', status: 'complete' },
    findings: [f1, f2, f3],
    ledgerCumulative: { fixes_applied: 47, waste_removed_usd: 640.4 },
    narrativeSlots: { exec_summary: 'x', since_last_week: 'y' },
  });
  assert.strictEqual(env.totals.waste_monthly_usd, 540, 'applied findings do not count as open waste');
  assert.strictEqual(env.totals.applied_this_run, 1);
  assert.strictEqual(env.totals.ledger_cumulative.fixes, 47);
  assert.strictEqual(env.findings[0].display.sort_weight, 88, 'sorted by weight desc');
  assert.strictEqual(env.counts.warning, 2);
});

test('narration input never contains payload', () => {
  const input = narrationInput(finding());
  assert.strictEqual(input.payload, undefined);
  assert.ok(!JSON.stringify(input).includes('free nail course'));
});

test('numbersAreGrounded: verbatim ok, derived numbers rejected', () => {
  const input = { money: { impact_monthly_usd: 340 }, evidence: { metrics: { term_count: 43 } } };
  assert.ok(numbersAreGrounded('43 terms waste $340 a month', input));
  assert.ok(!numbersAreGrounded('about $4,080 a year', input), 'derived yearly figure rejected');
  assert.ok(numbersAreGrounded('no numbers here at all', input));
});

test('narrateFinding: retries on ungrounded output, succeeds on grounded', async () => {
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return calls === 1
      ? JSON.stringify({ title: 'You waste $680 every two months', explanation: 'derived!' })
      : JSON.stringify({ title: '43 search terms are wasting money', explanation: 'About $340 a month is wasted.' });
  };
  const out = await narrateFinding(finding(), generate);
  assert.strictEqual(calls, 2);
  assert.match(out.title, /43/);
});

test('renderer: locked payload NEVER reaches the markup pre-unlock (server-side blur)', () => {
  const env = assembleEnvelope({
    run: { id: 'r1', type: 'signup_audit', status: 'complete' },
    findings: [finding()],
    ledgerCumulative: null,
    narrativeSlots: { exec_summary: 'One clear problem found.', since_last_week: '' },
  });
  const lockedHtml = renderReport(env, { unlocked: false, healthScore: 72, mode: 'email', links: { unlock_url: 'https://x/unlock' } });
  assert.ok(!lockedHtml.includes('free nail course'), 'entity value absent');
  assert.ok(!lockedHtml.includes('negative keywords'), 'fix detail absent');
  assert.match(lockedHtml, /1 search terms found|unlock the full report/i);
  assert.ok(lockedHtml.includes('https://x/unlock'));

  const openHtml = renderReport(env, { unlocked: true, healthScore: 72, mode: 'web' });
  assert.ok(openHtml.includes('free nail course'), 'entities render post-unlock');
  assert.ok(openHtml.includes('Add 43 negative keywords at campaign level; list attached.'));
});

test('renderer: unlocked-false findings with payload.locked=false render fully (alerts never paywalled)', () => {
  const alert = finding({
    rule_id: 'live.tag_alive', severity: 'critical',
    payload: { locked: false, entities: [{ kind: 'gtm_container', value: 'GTM-TEST123' }], fix_detail: 'One tap starts the reinstall flow.' },
  });
  const env = assembleEnvelope({ run: { id: 'r1', type: 'triggered', status: 'complete' }, findings: [alert], ledgerCumulative: null, narrativeSlots: {} });
  const html = renderReport(env, { unlocked: false, mode: 'email' });
  assert.ok(html.includes('GTM-TEST123'));
});

test('renderer: local currency shown when present; degraded notice honest', () => {
  const env = assembleEnvelope({
    run: { id: 'r1', type: 'weekly', status: 'degraded', degraded_reasons: ['ads data unavailable'] },
    findings: [finding()], ledgerCumulative: null, narrativeSlots: {},
  });
  const html = renderReport(env, { unlocked: true, mode: 'web' });
  assert.ok(html.includes('AED 1,249'));
  assert.match(html, /could not run this week/);
});
