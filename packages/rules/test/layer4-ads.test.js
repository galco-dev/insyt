const assert = require('node:assert');
const { test } = require('node:test');
const { rules, accountMedianCpa } = require('../src/layer4-ads');

const byId = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
const NOW = Date.parse('2026-08-19T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const baseAds = () => ({
  customer_id: '6424596144',
  currency: 'AED',
  spend_30d_usd: 3000,
  spend_90d_usd: 9000,
  conversion_actions: [
    { id: 'a1', name: 'WhatsApp taps', primary: true, count_30d: 40, last_conversion_at: daysAgo(1), source: 'ga4_import', ga4_event_name: 'whatsapp_click' },
  ],
  campaigns: [
    { id: 'c1', name: 'Brand', status: 'enabled', bidding: { strategy: 'tcpa', target: 20 }, budget_daily_usd: 30, budget_lost_is_pct: 0, spend_30d_usd: 900, conversions_30d: 45 },  // CPA 20
    { id: 'c2', name: 'Generic', status: 'enabled', bidding: { strategy: 'max_clicks' }, budget_daily_usd: 40, budget_lost_is_pct: 0, spend_30d_usd: 1200, conversions_30d: 30 },      // CPA 40
    { id: 'c3', name: 'Display test', status: 'enabled', bidding: { strategy: 'max_clicks' }, budget_daily_usd: 30, budget_lost_is_pct: 0, spend_30d_usd: 900, conversions_30d: 10 },  // CPA 90
  ],
  search_terms: [],
  disapproved: [],
  ads_conversions_30d: 85,
  ga4_key_events_30d: 80,
});

test('accountMedianCpa: median over enabled converting campaigns', () => {
  assert.strictEqual(accountMedianCpa(baseAds()), 40);
});

test('no_conversion_tracking: Journey C finding #1 with estimated monthly waste', () => {
  const ads = baseAds();
  ads.conversion_actions = [];
  const hits = byId['ads.no_conversion_tracking'].run({ ads, thresholds: {} });
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(hits[0].money, { impact_monthly_usd: 3000, direction: 'waste', confidence: 'estimated' });
  // healthy account clean; tiny spend clean
  assert.strictEqual(byId['ads.no_conversion_tracking'].run({ ads: baseAds(), thresholds: {} }).length, 0);
  ads.spend_90d_usd = 50;
  assert.strictEqual(byId['ads.no_conversion_tracking'].run({ ads, thresholds: {} }).length, 0);
});

test('conversion_silent: one silent primary among working ones, with GA4 cause join', () => {
  const ads = baseAds();
  ads.conversion_actions.push({ id: 'a2', name: 'Bookings', primary: true, count_30d: 0, last_conversion_at: daysAgo(30), source: 'ga4_import', ga4_event_name: 'book_now' });
  const hits = byId['ads.conversion_silent'].run({ ads, silentGa4Events: ['book_now'], thresholds: {}, now: NOW });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].payload.entities[0].likely_cause, 'ga4_event_silent');
  // all-primaries-silent is no_conversion_tracking territory, not this rule
  ads.conversion_actions[0].count_30d = 0;
  ads.conversion_actions[0].last_conversion_at = daysAgo(40);
  assert.strictEqual(byId['ads.conversion_silent'].run({ ads, silentGa4Events: [], thresholds: {}, now: NOW }).length, 0);
});

test('tcpa_blind: smart-bidding campaigns flagged when ALL primaries silent, both options emitted', () => {
  const ads = baseAds();
  ads.conversion_actions = [{ id: 'a1', name: 'Leads', primary: true, count_30d: 0, last_conversion_at: daysAgo(20), source: 'website', ga4_event_name: null }];
  const hits = byId['ads.tcpa_blind'].run({ ads, thresholds: {}, now: NOW });
  assert.strictEqual(hits.length, 1, 'only the tcpa campaign, not max_clicks ones');
  assert.strictEqual(hits[0].payload.entities[0].value, 'Brand');
  assert.strictEqual(hits[0].payload.options.length, 2);
  assert.strictEqual(byId['ads.tcpa_blind'].run({ ads: baseAds(), thresholds: {}, now: NOW }).length, 0);
});

test('dual_primary: two primaries on the same GA4 event', () => {
  const ads = baseAds();
  ads.conversion_actions.push({ id: 'a2', name: 'WhatsApp (legacy)', primary: true, count_30d: 38, last_conversion_at: daysAgo(1), source: 'website', ga4_event_name: 'whatsapp_click' });
  const hits = byId['ads.dual_primary'].run({ ads });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].payload.entities.length, 2);
  assert.strictEqual(byId['ads.dual_primary'].run({ ads: baseAds() }).length, 0);
});

test('divergence: beyond tolerance flagged, within tolerance and low volume clean', () => {
  const ads = baseAds();
  ads.ads_conversions_30d = 100; ads.ga4_key_events_30d = 40;
  const hits = byId['ads.divergence'].run({ ads, thresholds: {} });
  assert.strictEqual(hits[0].evidence.metrics.divergence_pct, 60);
  assert.strictEqual(byId['ads.divergence'].run({ ads: baseAds(), thresholds: {} }).length, 0);
  ads.ads_conversions_30d = 8; ads.ga4_key_events_30d = 2;
  assert.strictEqual(byId['ads.divergence'].run({ ads, thresholds: {} }).length, 0, 'min volume floor');
});

test('wasted_terms: measured monthly money, term list locked in payload', () => {
  const ads = baseAds();
  ads.search_terms = [
    { term: 'free nail course', campaign_id: 'c2', spend_90d_usd: 410, clicks_90d: 380, conversions_90d: 0 },
    { term: 'diy nails at home', campaign_id: 'c2', spend_90d_usd: 250, clicks_90d: 200, conversions_90d: 0 },
    { term: 'nail salon dubai', campaign_id: 'c2', spend_90d_usd: 900, clicks_90d: 400, conversions_90d: 22 }, // converts — excluded
    { term: 'cheap gel x', campaign_id: 'c3', spend_90d_usd: 2, clicks_90d: 4, conversions_90d: 0 },           // under floor
  ];
  const hits = byId['ads.wasted_terms'].run({ ads, thresholds: {} });
  assert.strictEqual(hits.length, 1);
  const f = hits[0];
  assert.deepStrictEqual(f.money, { impact_monthly_usd: 220, direction: 'waste', confidence: 'measured' });
  assert.strictEqual(f.evidence.metrics.term_count, 2);
  assert.strictEqual(f.payload.locked, true);
  assert.strictEqual(f.payload.entities[0].value, 'free nail course', 'sorted by spend');
  assert.strictEqual(byId['ads.wasted_terms'].run({ ads: baseAds(), thresholds: {} }).length, 0);
});

test('budget_constrained_winner: cheap CPA + lost impression share → opportunity', () => {
  const ads = baseAds();
  ads.campaigns[0].budget_lost_is_pct = 25; // Brand, CPA 20 < median 40
  const hits = byId['ads.budget_constrained_winner'].run({ ads, thresholds: {} });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].money.direction, 'opportunity');
  assert.strictEqual(hits[0].money.impact_monthly_usd, 225);
  ads.campaigns[2].budget_lost_is_pct = 25; // CPA 90 > median — expensive, not a winner
  assert.strictEqual(byId['ads.budget_constrained_winner'].run({ ads, thresholds: {} }).length, 1);
});

test('budget_bleeding_loser: zero-conversion spender and >2x-median CPA both flagged', () => {
  const ads = baseAds();
  ads.campaigns.push({ id: 'c4', name: 'Experiment', status: 'enabled', bidding: { strategy: 'max_clicks' }, budget_daily_usd: 10, budget_lost_is_pct: 0, spend_30d_usd: 300, conversions_30d: 0 });
  const hits = byId['ads.budget_bleeding_loser'].run({ ads, thresholds: {} });
  const keys = hits.map((h) => h.entity_key).sort();
  assert.deepStrictEqual(keys, ['c3', 'c4'], 'CPA-90 campaign (>2x median 40) and zero-conv campaign');
  const zero = hits.find((h) => h.entity_key === 'c4');
  assert.deepStrictEqual(zero.money, { impact_monthly_usd: 300, direction: 'waste', confidence: 'measured' });
});

test('disapproved_ads: only counts ads inside enabled campaigns', () => {
  const ads = baseAds();
  ads.campaigns.push({ id: 'c9', name: 'Paused one', status: 'paused', bidding: {}, spend_30d_usd: 0, conversions_30d: 0 });
  ads.disapproved = [
    { ad_id: 901, ad_group: 'g1', campaign_id: 'c1', policy: 'destination_not_working' },
    { ad_id: 902, ad_group: 'g2', campaign_id: 'c9', policy: 'trademark' },
  ];
  const hits = byId['ads.disapproved_ads'].run({ ads });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].evidence.metrics.disapproved_count, 1);
});
