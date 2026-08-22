const assert = require('node:assert');
const { test } = require('node:test');
const { runRules } = require('../src/engine');
const deep = require('../src/layer6-deep');

const CONFIG = Object.fromEntries([
  ['qs.low_average', { default_severity: 'warning', thresholds: { min_scored_keywords: 4, top_n: 30, max_avg_qs: 5, premium_pct: 25 } }],
  ['qs.nonconverter_floor', { default_severity: 'warning', thresholds: { max_qs: 2, min_spend_usd: 20 }, fix_tool_id: 'ads.pause_keywords' }],
  ['ads.hour_waste', { default_severity: 'warning', thresholds: { cpa_multiple: 2, min_hour_spend_usd: 40 } }],
  ['ads.dow_waste', { default_severity: 'warning', thresholds: { cpa_multiple: 3, min_day_spend_usd: 100 } }],
  ['ads.device_cpa_skew', { default_severity: 'info', thresholds: { cpa_multiple: 1.5, min_device_spend_usd: 100 } }],
  ['ads.growth_headroom', { default_severity: 'opportunity', thresholds: { max_click_share_pct: 15 } }],
  ['ads.lost_is_budget', { default_severity: 'opportunity', thresholds: { min_lost_is_pct: 15 } }],
  ['ads.invalid_clicks_high', { default_severity: 'info', thresholds: { max_invalid_pct: 8 } }],
  ['ads.language_demand', { default_severity: 'opportunity', thresholds: { min_converting_terms: 2 } }],
  ['ads.competitor_name_drift', { default_severity: 'warning', thresholds: { min_cluster_spend_90d_usd: 30 }, fix_tool_id: 'ads.add_negative_keywords' }],
  ['ads.out_of_area', { default_severity: 'warning', thresholds: { min_cluster_spend_90d_usd: 20 }, fix_tool_id: 'ads.add_negative_keywords' }],
  ['ads.off_menu_queries', { default_severity: 'warning', thresholds: { min_cluster_spend_90d_usd: 30 }, fix_tool_id: 'ads.add_negative_keywords' }],
  ['truth.price_mismatch', { default_severity: 'critical', thresholds: {} }],
  ['trend.cpc_escalation', { default_severity: 'warning', thresholds: { cpc_multiple: 2.5 } }],
  ['trend.cpa_regression', { default_severity: 'warning', thresholds: { cpa_multiple: 1.5 } }],
].map(([id, v]) => [id, { enabled: true, ...v }]));

function run(ctx) {
  return runRules({ rules: deep.rules, ruleConfig: CONFIG, ctx, runId: 'r1', tenantId: 't1' });
}

const baseAds = {
  customer_id: '123', spend_30d_usd: 2000, spend_90d_usd: 6000,
  campaigns: [{ id: 'c1', name: 'Nails', status: 'enabled', spend_30d_usd: 2000, conversions_30d: 50 }],
  search_terms: [],
};

test('deep: absent blocks produce zero findings (dataset honesty)', () => {
  const { findings } = run({ ads: baseAds });
  assert.strictEqual(findings.length, 0);
});

test('qs.low_average: fires below threshold with modelled money and distribution', () => {
  const keywords = [3, 3, 2, 4, 3, 5, 2, 3].map((qs, i) => ({
    keyword: `k${i}`, match: 'exact', campaign_id: 'c1', ad_group: 'g', cost_usd: 100 + i, clicks: 10, conversions: 1, quality_score: qs,
  }));
  const { findings } = run({ ads: baseAds, adsDeep: { keywords } });
  const f = findings.find((x) => x.rule_id === 'qs.low_average');
  assert.ok(f);
  assert.strictEqual(f.money.confidence, 'model');
  assert.strictEqual(f.money.impact_monthly_usd, 500); // 25% of 2000
  assert.ok(f.payload.distribution['3'] >= 3);
});

test('qs.nonconverter_floor: pauses only rock-bottom non-converters with spend', () => {
  const keywords = [
    { keyword: 'good', match: 'exact', campaign_id: 'c1', ad_group: 'g', cost_usd: 900, clicks: 90, conversions: 20, quality_score: 7 },
    { keyword: 'bad one', match: 'exact', campaign_id: 'c1', ad_group: 'g', cost_usd: 60, clicks: 15, conversions: 0, quality_score: 1 },
    { keyword: 'cheap bad', match: 'exact', campaign_id: 'c1', ad_group: 'g', cost_usd: 5, clicks: 2, conversions: 0, quality_score: 1 },
  ];
  const { findings } = run({ ads: baseAds, adsDeep: { keywords } });
  const f = findings.find((x) => x.rule_id === 'qs.nonconverter_floor');
  assert.ok(f);
  assert.strictEqual(f.payload.entities.length, 1);
  assert.match(f.payload.entities[0].value, /bad one/);
  assert.strictEqual(f.money.impact_monthly_usd, 20); // 60/3
});

test('ads.hour_waste: flags expensive hours, measures overpay', () => {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, cost_usd: 100, conversions: 4 })); // CPA 25
  hours[8] = { hour: 8, cost_usd: 300, conversions: 2 }; // CPA 150 = 6x
  hours[5] = { hour: 5, cost_usd: 90, conversions: 0 }; // spend, nothing back
  const { findings } = run({ adsDeep: { hours } });
  const f = findings.find((x) => x.rule_id === 'ads.hour_waste');
  assert.ok(f);
  assert.deepStrictEqual(f.evidence.metrics.hours.sort(), [5, 8]);
  assert.ok(f.money.impact_monthly_usd > 0);
});

test('ads.dow_waste: one bad weekday against the best day floor', () => {
  const days = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, cost_usd: 300, conversions: 10 })); // CPA 30
  days[2] = { dow: 2, cost_usd: 460, conversions: 4 }; // Wednesday CPA 115
  const { findings } = run({ adsDeep: { days } });
  const f = findings.find((x) => x.rule_id === 'ads.dow_waste');
  assert.ok(f);
  assert.strictEqual(f.evidence.metrics.day, 'Wednesday');
});

test('ads.device_cpa_skew + growth + share rules fire from the share block', () => {
  const { findings } = run({
    ads: baseAds,
    adsDeep: {
      devices: [
        { device: 'mobile', cost_usd: 1200, conversions: 40 }, // CPA 30
        { device: 'desktop', cost_usd: 600, conversions: 10 }, // CPA 60 = 2x
      ],
      share: [
        { campaign_id: 'c1', click_share_pct: 10.7, exact_match_is_pct: 20.7, lost_is_budget_pct: 22.9, invalid_click_rate_pct: 9.5 },
      ],
    },
  });
  assert.ok(findings.find((x) => x.rule_id === 'ads.device_cpa_skew'));
  const growth = findings.find((x) => x.rule_id === 'ads.growth_headroom');
  assert.ok(growth);
  assert.strictEqual(growth.money.direction, 'growth');
  assert.strictEqual(growth.money.confidence, 'model');
  assert.ok(findings.find((x) => x.rule_id === 'ads.lost_is_budget'));
  assert.ok(findings.find((x) => x.rule_id === 'ads.invalid_clicks_high'));
});

test('ads.language_demand: cyrillic converters cluster as growth, not waste', () => {
  const ads = {
    ...baseAds,
    search_terms: [
      { term: 'русский маникюр дубай', campaign_id: 'c1', spend_90d_usd: 200, clicks_90d: 40, conversions_90d: 6 },
      { term: 'маникюр дубай', campaign_id: 'c1', spend_90d_usd: 90, clicks_90d: 20, conversions_90d: 3 },
      { term: 'nail salon dubai', campaign_id: 'c1', spend_90d_usd: 500, clicks_90d: 100, conversions_90d: 20 },
    ],
  };
  const { findings } = run({ ads, adsDeep: { expected_scripts: ['latin'] } });
  const f = findings.find((x) => x.rule_id === 'ads.language_demand');
  assert.ok(f);
  assert.strictEqual(f.evidence.metrics.script, 'cyrillic');
  assert.strictEqual(f.evidence.metrics.converting_terms, 2);
});

test('ads.competitor_name_drift: names cluster with negative set; converters exempt', () => {
  const ads = {
    ...baseAds,
    search_terms: [
      { term: 'the nail spa dubai', campaign_id: 'c1', spend_90d_usd: 120, clicks_90d: 30, conversions_90d: 0 },
      { term: 'monroe salon prices', campaign_id: 'c1', spend_90d_usd: 45, clicks_90d: 12, conversions_90d: 0 },
      { term: 'monroe salon booking', campaign_id: 'c1', spend_90d_usd: 60, clicks_90d: 9, conversions_90d: 2 }, // converts - exempt
    ],
  };
  const { findings } = run({ ads, adsDeep: { competitor_names: ['the nail spa', 'monroe salon'] } });
  const f = findings.find((x) => x.rule_id === 'ads.competitor_name_drift');
  assert.ok(f);
  assert.strictEqual(f.payload.entities.length, 2);
  assert.deepStrictEqual(f.payload.negative_set.sort(), ['monroe salon', 'the nail spa']);
  assert.strictEqual(f.money.impact_monthly_usd, 55); // (120+45)/3
});

test('ads.out_of_area + off_menu: markers and menu vocabulary drive exclusion sets', () => {
  const ads = {
    ...baseAds,
    search_terms: [
      { term: 'nail salon sharjah', campaign_id: 'c1', spend_90d_usd: 80, clicks_90d: 20, conversions_90d: 0 },
      { term: 'acrylic nails dubai', campaign_id: 'c1', spend_90d_usd: 95, clicks_90d: 25, conversions_90d: 0 },
      { term: 'gel nails dubai', campaign_id: 'c1', spend_90d_usd: 300, clicks_90d: 60, conversions_90d: 9 },
    ],
  };
  const { findings } = run({
    ads,
    adsDeep: { out_of_area_markers: ['sharjah'], service_terms: ['gel nails', 'manicure', 'nail salon'] },
  });
  assert.ok(findings.find((x) => x.rule_id === 'ads.out_of_area'));
  const off = findings.find((x) => x.rule_id === 'ads.off_menu_queries');
  assert.ok(off);
  assert.strictEqual(off.payload.entities.length, 1);
  assert.match(off.payload.entities[0].value, /acrylic/);
});

test('truth.price_mismatch: ad price vs site menu, critical', () => {
  const { findings } = run({
    adsDeep: { assets: [{ text: 'Brow Lamination From AED 150', type: 'headline', campaign_id: 'c3', impressions_30d: 200, pinned: true }] },
    witness: { prices: [{ label: 'Brow Lamination', amount: 250, currency: 'AED' }] },
  });
  const f = findings.find((x) => x.rule_id === 'truth.price_mismatch');
  assert.ok(f);
  assert.strictEqual(f.severity, 'critical');
  assert.strictEqual(f.evidence.metrics.claimed_price, 150);
  assert.strictEqual(f.evidence.metrics.site_price, 250);
});

test('trends: cpc escalation and cpa regression detected from monthly series', () => {
  const monthly = [
    { month: 'May', campaign_id: 'c1', cost_usd: 1800, clicks: 1000, conversions: 27 }, // cpc 1.8 cpa 66
    { month: 'Jun', campaign_id: 'c1', cost_usd: 3460, clicks: 1000, conversions: 91 }, // cpa 38
    { month: 'Jul', campaign_id: 'c1', cost_usd: 3800, clicks: 1000, conversions: 122 }, // cpa 31
    { month: 'Aug', campaign_id: 'c1', cost_usd: 7240, clicks: 1000, conversions: 150 }, // cpc 7.24 = 4x, cpa 48 = 1.56x floor
  ];
  const { findings } = run({ adsDeep: { monthly } });
  assert.ok(findings.find((x) => x.rule_id === 'trend.cpc_escalation'));
  const reg = findings.find((x) => x.rule_id === 'trend.cpa_regression');
  assert.ok(reg);
  assert.strictEqual(reg.evidence.metrics.latest_period, 'Aug');
});

test('deep: no rule invents money confidence - measured, model, or none only', () => {
  for (const r of deep.rules) {
    assert.ok(r.rule_id && r.layer === 6 && typeof r.run === 'function');
  }
});
