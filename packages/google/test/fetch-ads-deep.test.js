const assert = require('node:assert');
const { test } = require('node:test');
const { fetchAdsDeep } = require('../src/fetch-ads-deep');
const { search } = require('../src/fetch-ads');
const deep = require('../../rules/src/layer6-deep');
const { runRules } = require('../../rules/src/engine');

// Fake authed API: routes each GAQL query by its FROM clause and returns
// API-shaped rows (camelCase, micros), including one paged response.
function fakeAuth(overrides = {}) {
  const calls = [];
  const rows = {
    customer: (q) => (q.includes('segments.date')
      ? [{ segments: { date: '2026-08-01' }, metrics: { costMicros: '12000000', conversions: 2, conversionsValue: 300 } },
        { segments: { date: '2026-08-02' }, metrics: { costMicros: '8000000', conversions: 0, conversionsValue: 0 } }]
      : [{ customer: { currencyCode: 'AED', timeZone: 'Asia/Dubai' } }]),
    keyword_view: () => [
      { adGroupCriterion: { keyword: { text: 'gel nails', matchType: 'EXACT' }, qualityInfo: { qualityScore: 3 } }, campaign: { id: '11' }, adGroup: { name: 'g1' }, metrics: { costMicros: '50000000', clicks: 40, conversions: 1 } },
      { adGroupCriterion: { keyword: { text: 'gel nails', matchType: 'EXACT' }, qualityInfo: { qualityScore: 3 } }, campaign: { id: '11' }, adGroup: { name: 'g1' }, metrics: { costMicros: '25000000', clicks: 20, conversions: 1 } },
      { adGroupCriterion: { keyword: { text: 'nails', matchType: 'BROAD' } }, campaign: { id: '11' }, adGroup: { name: 'g1' }, metrics: { costMicros: '10000000', clicks: 9, conversions: 0 } },
    ],
    campaign: (q) => {
      if (q.includes('segments.hour')) return Array.from({ length: 24 }, (_, h) => ({ segments: { hour: h }, metrics: { costMicros: String(h * 1_000_000), conversions: h % 3 === 0 ? 1 : 0 } }));
      if (q.includes('segments.day_of_week')) return ['MONDAY', 'TUESDAY', 'SUNDAY'].map((d) => ({ segments: { dayOfWeek: d }, metrics: { costMicros: '100000000', conversions: 2 } }));
      if (q.includes('segments.device')) return [{ segments: { device: 'MOBILE' }, metrics: { costMicros: '200000000', conversions: 4 } }, { segments: { device: 'DESKTOP' }, metrics: { costMicros: '100000000', conversions: 1 } }];
      if (q.includes('segments.month')) return [{ segments: { month: '2026-05-01' }, campaign: { id: '11' }, metrics: { costMicros: '1000000', clicks: 10, conversions: 1 } }, { segments: { month: '2026-06-01' }, campaign: { id: '11' }, metrics: { costMicros: '2000000', clicks: 10, conversions: 1 } }];
      if (q.includes('search_click_share')) return [{ campaign: { id: '11' }, metrics: { searchClickShare: 0.123, searchExactMatchImpressionShare: 0.5, searchBudgetLostImpressionShare: 0.2, invalidClickRate: 0.09, costMicros: '300000000' } }];
      return [];
    },
    ad_group_ad_asset_view: () => [
      { campaign: { id: '11' }, adGroupAdAssetView: { fieldType: 'HEADLINE', pinnedField: 'HEADLINE_1', performanceLabel: 'BEST' }, asset: { textAsset: { text: 'Gel Nails from AED 99' } }, metrics: { impressions: '1200' } },
      { campaign: { id: '11' }, adGroupAdAssetView: { fieldType: 'DESCRIPTION', pinnedField: 'UNSPECIFIED', performanceLabel: 'LOW' }, asset: { textAsset: { text: 'Book today.' } }, metrics: { impressions: '300' } },
    ],
    ...overrides,
  };
  return {
    calls,
    api: async (tenantId, url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const from = /FROM\s+(\w+)/i.exec(body.query)[1];
      const fn = rows[from];
      if (!fn) throw Object.assign(new Error('bad resource'), { code: 'INVALID_ARGUMENT' });
      if (fn === 'FAIL') throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
      const results = fn(body.query);
      // One paged response for keyword_view to exercise nextPageToken.
      if (from === 'keyword_view' && !body.pageToken) return { results: results.slice(0, 2), nextPageToken: 'p2' };
      if (from === 'keyword_view') return { results: results.slice(2) };
      return { results };
    },
  };
}

const base = { tenantId: 't1', customerId: '123-456-7890', developerToken: 'dev', loginCustomerId: '3315824995', now: Date.parse('2026-08-26T10:00:00Z') };

test('search: follows nextPageToken and never sends pageSize', async () => {
  const auth = fakeAuth();
  const rows = await search({ auth, ...base, query: 'SELECT x FROM keyword_view' });
  assert.strictEqual(rows.length, 3);
  assert.ok(auth.calls.every((c) => !('pageSize' in c)));
  assert.strictEqual(auth.calls[1].pageToken, 'p2');
});

test('fetchAdsDeep: measured blocks in the layer-6 contract shape', async () => {
  const auth = fakeAuth();
  const d = await fetchAdsDeep({ auth, ...base });
  assert.strictEqual(d.currency_code, 'AED');
  // keywords aggregate across date rows, keep QS, map match types
  const gel = d.keywords.find((k) => k.keyword === 'gel nails');
  assert.deepStrictEqual({ match: gel.match, cost: gel.cost_usd, clicks: gel.clicks, conv: gel.conversions, qs: gel.quality_score, cid: gel.campaign_id },
    { match: 'exact', cost: 75, clicks: 60, conv: 2, qs: 3, cid: '11' });
  assert.strictEqual(d.keywords.find((k) => k.keyword === 'nails').quality_score, null);
  assert.strictEqual(d.hours.length, 24);
  assert.deepStrictEqual(d.days.map((x) => x.dow), [0, 1, 6]);
  assert.deepStrictEqual(d.devices.map((x) => x.device).sort(), ['desktop', 'mobile']);
  assert.deepStrictEqual(d.share[0], { campaign_id: '11', campaign_name: null, click_share_pct: 12.3, exact_match_is_pct: 50, lost_is_budget_pct: 20, invalid_click_rate_pct: 9, spend_30d_usd: 300 });
  assert.deepStrictEqual(d.monthly.map((m) => m.month), ['May', 'Jun']);
  assert.strictEqual(d.assets[0].pinned, true);
  assert.strictEqual(d.assets[1].pinned, false);
  assert.strictEqual(d.assets[0].performance_label, 'BEST');
  assert.deepStrictEqual(d.daily[0], { date: '2026-08-01', cost_usd: 12, conversions: 2, conversion_value_usd: 300 });
  assert.ok(Object.values(d.blocks).every((b) => b.status === 'measured'));
});

test('fetchAdsDeep: a failing block is null (not yet examined), the rest measured', async () => {
  const auth = fakeAuth({ keyword_view: 'FAIL' });
  const d = await fetchAdsDeep({ auth, ...base });
  assert.strictEqual(d.keywords, null);
  assert.strictEqual(d.blocks.keywords.status, 'unavailable');
  assert.strictEqual(d.blocks.keywords.reason, 'PERMISSION_DENIED');
  assert.ok(Array.isArray(d.hours));
});

test('fetchAdsDeep output drives the deep rules without adapter code', async () => {
  const auth = fakeAuth();
  const adsDeep = await fetchAdsDeep({ auth, ...base });
  const config = Object.fromEntries(deep.rules.map((r) => [r.rule_id, { enabled: true, default_severity: 'warning', thresholds: {} }]));
  const { findings, errors } = runRules({
    rules: deep.rules, ruleConfig: config, runId: 'r', tenantId: 't1',
    ctx: { ads: { customer_id: '123', spend_30d_usd: 300, campaigns: [], search_terms: [] }, adsDeep },
  });
  assert.strictEqual(errors.length, 0);
  // share block: click share 12.3% ≤ 15 → growth headroom; lost IS 20% ≥ 15; invalid 9% ≥ 8
  for (const id of ['ads.growth_headroom', 'ads.lost_is_budget', 'ads.invalid_clicks_high']) {
    assert.ok(findings.some((f) => f.rule_id === id), `expected ${id}`);
  }
});
