// RSA coverage/quality + final-URL health + build-gap rules (P1 set).
const assert = require('node:assert');
const { test } = require('node:test');
const { runRules } = require('../src/engine');
const rsa = require('../src/layer4-rsa');
const urls = require('../src/layer5-urls');

const CONFIG = {
  'rsa.missing': { default_severity: 'critical', thresholds: {}, enabled: true },
  'rsa.thin_assets': { default_severity: 'warning', thresholds: { min_headlines: 8, min_descriptions: 3 }, enabled: true },
  'rsa.over_pinned': { default_severity: 'warning', thresholds: { max_pinned: 2 }, enabled: true },
  'rsa.poor_strength': { default_severity: 'warning', thresholds: {}, enabled: true },
  'ads.missing_brand_campaign': { default_severity: 'opportunity', thresholds: { min_spend_30d_usd: 300 }, enabled: true },
  'ads.missing_remarketing': { default_severity: 'opportunity', thresholds: { min_spend_30d_usd: 1000 }, enabled: true },
  'url.broken': { default_severity: 'critical', thresholds: {}, enabled: true },
  'url.redirect_chain': { default_severity: 'warning', thresholds: { max_hops: 1 }, enabled: true },
  'url.slow': { default_severity: 'warning', thresholds: { max_load_ms: 4000 }, enabled: true },
};

const run = (rules, ctx) => runRules({ rules, ruleConfig: CONFIG, ctx, runId: 'r1', tenantId: 't1' });

const adsBase = {
  customer_id: '111',
  spend_30d_usd: 2000,
  campaigns: [
    { id: '10', name: 'Gel & Extensions', status: 'enabled' },
    { id: '11', name: 'Old — Paused', status: 'paused' },
  ],
  ad_groups: [
    { id: 'g1', name: 'Gel', campaign_id: '10', status: 'enabled', rsas: [{ ad_id: 'a1', strength: 'GOOD', headline_count: 12, description_count: 4, pinned_headlines: 1, pinned_descriptions: 0 }] },
  ],
};

test('rsa.missing fires only for enabled groups in enabled campaigns', () => {
  const ctx = { ads: { ...adsBase, ad_groups: [
    ...adsBase.ad_groups,
    { id: 'g2', name: 'Empty', campaign_id: '10', status: 'enabled', rsas: [] },
    { id: 'g3', name: 'In paused campaign', campaign_id: '11', status: 'enabled', rsas: [] },
    { id: 'g4', name: 'Paused group', campaign_id: '10', status: 'paused', rsas: [] },
  ] } };
  const { findings } = run(rsa.rules, ctx);
  const missing = findings.filter((f) => f.rule_id === 'rsa.missing');
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].entity_key, 'adgroup:g2');
  assert.strictEqual(missing[0].payload.campaign_name, 'Gel & Extensions');
});

test('rsa thin/pinned/strength thresholds', () => {
  const ctx = { ads: { ...adsBase, ad_groups: [
    { id: 'g1', name: 'Thin', campaign_id: '10', status: 'enabled', rsas: [{ ad_id: 'a1', strength: 'AVERAGE', headline_count: 5, description_count: 2, pinned_headlines: 0, pinned_descriptions: 0 }] },
    { id: 'g2', name: 'Pinned', campaign_id: '10', status: 'enabled', rsas: [{ ad_id: 'a2', strength: 'GOOD', headline_count: 12, description_count: 4, pinned_headlines: 3, pinned_descriptions: 1 }] },
    { id: 'g3', name: 'Weak', campaign_id: '10', status: 'enabled', rsas: [{ ad_id: 'a3', strength: 'POOR', headline_count: 9, description_count: 3, pinned_headlines: 0, pinned_descriptions: 0 }] },
    { id: 'g4', name: 'Fine', campaign_id: '10', status: 'enabled', rsas: [{ ad_id: 'a4', strength: 'EXCELLENT', headline_count: 10, description_count: 4, pinned_headlines: 1, pinned_descriptions: 0 }] },
  ] } };
  const { findings } = run(rsa.rules, ctx);
  const ids = findings.map((f) => f.rule_id).filter((r) => r.startsWith('rsa.')).sort();
  assert.deepStrictEqual(ids, ['rsa.over_pinned', 'rsa.poor_strength', 'rsa.thin_assets']);
});

test('build-gap rules: brand fires without a brand campaign, respects spend floor; remarketing detects by name', () => {
  const { findings } = run(rsa.rules, { ads: { ...adsBase, spend_30d_usd: 2000 } });
  assert.ok(findings.some((f) => f.rule_id === 'ads.missing_brand_campaign' && f.payload.build_template === 'brand'));
  assert.ok(findings.some((f) => f.rule_id === 'ads.missing_remarketing'));

  const low = run(rsa.rules, { ads: { ...adsBase, spend_30d_usd: 100 } });
  assert.ok(!low.findings.some((f) => f.rule_id.startsWith('ads.missing')));

  const covered = run(rsa.rules, { ads: { ...adsBase, campaigns: [
    { id: '10', name: 'Brand — Glow', status: 'enabled' },
    { id: '12', name: 'Remarketing — Glow', status: 'enabled' },
  ], ad_groups: [] } });
  assert.ok(!covered.findings.some((f) => f.rule_id.startsWith('ads.missing')));
});

test('url rules: broken (hard + soft 404) with spend attribution, redirect chains, slow pages', () => {
  const ctx = { urlHealth: {
    spend_30d_by_campaign: { 10: 900 },
    checks: [
      { url: 'https://x.com/dead', campaign_id: '10', campaign_name: 'Gel', ad_count: 3, status: 404, redirect_hops: 0, load_ms: 800 },
      { url: 'https://x.com/soft', campaign_id: '10', campaign_name: 'Gel', ad_count: 1, status: 200, soft_404: true, redirect_hops: 0, load_ms: 900 },
      { url: 'https://x.com/hops', campaign_id: '10', campaign_name: 'Gel', ad_count: 2, status: 200, redirect_hops: 3, load_ms: 1200 },
      { url: 'https://x.com/slow', campaign_id: '10', campaign_name: 'Gel', ad_count: 1, status: 200, redirect_hops: 0, load_ms: 6200 },
      { url: 'https://x.com/fine', campaign_id: '10', campaign_name: 'Gel', ad_count: 4, status: 200, redirect_hops: 1, load_ms: 1400 },
    ],
  } };
  const { findings } = run(urls.rules, ctx);
  const broken = findings.filter((f) => f.rule_id === 'url.broken');
  assert.strictEqual(broken.length, 2);
  assert.strictEqual(broken[0].money.impact_monthly_usd, 450); // 50% of campaign spend
  assert.strictEqual(findings.filter((f) => f.rule_id === 'url.redirect_chain').length, 1);
  assert.strictEqual(findings.filter((f) => f.rule_id === 'url.slow').length, 1);
  // campaign refs ride through for the scope bar
  assert.ok(findings.every((f) => f.payload.campaign_ref === '10'));
});
