const assert = require('node:assert');
const { test } = require('node:test');
const { assembleDeep } = require('../src/deep');
const { assembleEnvelope } = require('../src/envelope');
const { renderReport } = require('../src/render');

const adsDeep = {
  monthly: [
    { month: 'May', campaign_id: 'c1', cost_usd: 3100, clicks: 1700, conversions: 47 },
    { month: 'Jun', campaign_id: 'c1', cost_usd: 3580, clicks: 1000, conversions: 94 },
    { month: 'Jul', campaign_id: 'c1', cost_usd: 5400, clicks: 1400, conversions: 174 },
    { month: 'Aug', campaign_id: 'c1', cost_usd: 2720, clicks: 600, conversions: 92 },
  ],
  hours: Array.from({ length: 24 }, (_, hour) => ({ hour, cost_usd: 90 + (hour === 8 ? 300 : 0), conversions: hour === 8 ? 2 : 3 })),
  share: [{ campaign_id: 'c1', campaign_name: 'Nails', click_share_pct: 10.7, exact_match_is_pct: 20.7, lost_is_budget_pct: 22.9, invalid_click_rate_pct: 5.5 }],
  keywords: [
    { keyword: 'biab manicure', match: 'phrase', campaign_id: 'c1', ad_group: 'Discovery', cost_usd: 608, clicks: 129, conversions: 32, quality_score: 5 },
    { keyword: 'manicure near me', match: 'exact', campaign_id: 'c1', ad_group: 'Near Me', cost_usd: 60, clicks: 15, conversions: 0, quality_score: 1 },
  ],
  conversion_mix: [
    { signal: 'whatsapp_click', count: 44, note: 'Primary booking route' },
    { signal: 'book_appointment', count: 21, note: '' },
  ],
  assets: [{ text: 'Book On WhatsApp', type: 'headline', campaign_id: 'c1', impressions_30d: 500, pinned: true }],
};

const findings = [
  {
    rule_id: 'qs.low_average', severity: 'warning', status: 'open', title: 'Low quality ratings tax every click',
    money: { impact_monthly_usd: 500, direction: 'waste', confidence: 'model' },
    evidence: { metrics: { avg_qs: 3.5 }, window_days: 30 },
    payload: { distribution: { 2: 3, 3: 8, 5: 5, 7: 2 } },
    category: 'quality',
  },
  {
    rule_id: 'ads.hour_waste', severity: 'warning', status: 'open', title: 'Two hours pay double',
    money: { impact_monthly_usd: 240, direction: 'waste', confidence: 'measured' },
    evidence: { metrics: { hours: [8] }, window_days: 30 },
    payload: { fix_detail: 'Exclude the hours.' },
    category: 'schedule_waste',
  },
  {
    rule_id: 'trend.cpa_regression', severity: 'warning', status: 'open', title: 'Cost per result left its floor',
    money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
    evidence: { metrics: { latest_period: 'Aug' }, window_days: 120 },
    payload: {},
    category: 'trend',
  },
];

const changes = [
  { id: 'N-01', kind: 'pause', item: 'manicure near me [Exact]', rationale: 'lowest rating, zero results', executor: 'Insyt', status: 'applied', verified_at: '20 Aug', recovered_usd: 96 },
];

test('assembleDeep: builds sections from data blocks, honest about absences', () => {
  const deep = assembleDeep({ adsDeep, findings, changes, witness: null, extraUnexamined: ['seasonality'] });
  assert.ok(deep.money_picture.modelled);
  assert.strictEqual(deep.money_picture.x_labels.length, 4);
  assert.strictEqual(deep.money_picture.measured_waste_monthly, 240);
  assert.strictEqual(deep.cpa_curve.regression_period, 'Aug');
  assert.strictEqual(deep.qs_distribution.bins.length, 4);
  assert.strictEqual(deep.qs_distribution.bins[0].status, 'critical');
  assert.deepStrictEqual(deep.hour_profile.flagged, [8]);
  assert.strictEqual(deep.headroom.rows[0].label, 'Nails');
  assert.strictEqual(deep.keyword_table.rows.length, 2);
  assert.strictEqual(deep.keyword_table.rows[1].status, 'serious');
  assert.strictEqual(deep.conversion_mix[0].share_pct, 68);
  assert.strictEqual(deep.execution_register.rows[0].id, 'N-01');
  assert.strictEqual(deep.leak_ledger.totals.recovered_usd, 96);
  assert.strictEqual(deep.leak_ledger.totals.calendar_usd, 240);
  assert.strictEqual(deep.leak_ledger.totals.active_usd, 0);
  assert.ok(deep.unexamined.includes('Website price menu cross-check'));
  assert.ok(deep.unexamined.includes('Seasonal patterns (needs a longer history)'));
  assert.ok(deep.unexamined.includes('Day-of-week spend and results'));
});

test('render: web mode carries charts and locks deep tables; unlock reveals rows', () => {
  const deep = assembleDeep({ adsDeep, findings, changes });
  const envelope = assembleEnvelope({
    run: { id: 'r1', type: 'deep', status: 'complete' },
    findings, ledgerCumulative: { fixes_applied: 3, waste_removed_usd: 400 },
    narrativeSlots: { exec_summary: 'Summary.', since_last_week: '' },
    deep,
  });
  const locked = renderReport(envelope, { unlocked: false, healthScore: 58, mode: 'web' });
  assert.ok(locked.includes('<svg'), 'web mode renders charts');
  assert.ok(!locked.includes('biab manicure'), 'keyword rows hidden while locked');
  assert.ok(locked.includes('rows in the full report'), 'locked placeholder shows');
  assert.ok(locked.includes('modelled'), 'modelled label present');
  assert.ok(locked.includes('Not yet examined'), 'unexamined section always visible');

  const open = renderReport(envelope, { unlocked: true, healthScore: 58, mode: 'web' });
  assert.ok(open.includes('biab manicure'), 'unlock reveals keyword rows');
  assert.ok(open.includes('N-01'), 'unlock reveals execution register');
});

test('render: email mode carries no SVG, points at the full report instead', () => {
  const deep = assembleDeep({ adsDeep, findings, changes });
  const envelope = assembleEnvelope({
    run: { id: 'r1', type: 'deep', status: 'complete' },
    findings, ledgerCumulative: {}, narrativeSlots: {}, deep,
  });
  const email = renderReport(envelope, { unlocked: false, healthScore: 58, mode: 'email' });
  assert.ok(!email.includes('<svg'), 'no SVG in email HTML');
  assert.ok(email.includes('full report carries the charts'));
});

test('render: blur boundary holds - locked markup never contains entity values', () => {
  const deep = assembleDeep({ adsDeep, findings, changes });
  const envelope = assembleEnvelope({
    run: { id: 'r1', type: 'deep', status: 'complete' },
    findings, ledgerCumulative: {}, narrativeSlots: {}, deep,
  });
  const locked = renderReport(envelope, { unlocked: false, mode: 'web' });
  assert.ok(!locked.includes('manicure near me'), 'locked page carries no keyword entities');
  assert.ok(!locked.includes('N-01'), 'locked page carries no register rows');
});
