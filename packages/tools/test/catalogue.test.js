const assert = require('node:assert');
const { test } = require('node:test');
const { byId } = require('../src/catalogue');

const ctx = () => ({
  account: { daily_budget_total_usd: 100, weekly_budget_delta_pct: 0, platform_min_daily_usd: 1 },
  campaign: (id) => ({ c1: { budget_daily_usd: 30, conversions_30d: 45, bidding: { target: 20 } }, c2: { budget_daily_usd: 40, conversions_30d: 5, bidding: {} } }[id]),
  convertingTerms: new Set(['nail salon dubai']),
  pausedByUs: new Set(['c9']),
  primaryActionCount: 2,
  keyEventCount: 3,
  linkedAdsCustomerIds: ['6424596144'],
  approvals: [{ scope: 'campaign_launch', target_id: 'c5' }, { scope: 'changeset', target_id: 'cs1' }],
  gates: { tag: true, billing: true, approval: true },
});

test('negatives: 200 cap, match types, converting-term blocklist', () => {
  const g = byId['ads.add_negative_keywords'].guard;
  const terms = (n, mt = 'exact') => Array.from({ length: n }, (_, i) => ({ text: `t${i}`, match_type: mt }));
  assert.strictEqual(g({ campaign_id: 'c1', terms: terms(200) }, ctx()), null);
  assert.match(g({ campaign_id: 'c1', terms: terms(201) }, ctx()), /200/);
  assert.match(g({ campaign_id: 'c1', terms: terms(3, 'broad') }, ctx()), /exact and phrase only/);
  assert.match(g({ campaign_id: 'c1', terms: [{ text: 'nail salon dubai', match_type: 'exact' }] }, ctx()), /converting term/);
});

test('budget: ±25%/run, ±40%/week account, 2x ceiling, platform floor', () => {
  const g = byId['ads.adjust_budget'].guard;
  assert.strictEqual(g({ campaign_id: 'c1', new_daily_usd: 37 }, ctx()), null); // +23%
  assert.match(g({ campaign_id: 'c1', new_daily_usd: 40 }, ctx()), /25%/);
  const spent = ctx(); spent.account.weekly_budget_delta_pct = 30;
  assert.match(g({ campaign_id: 'c1', new_daily_usd: 36 }, spent), /40% account\/week/);
  const rich = ctx(); rich.campaign = () => ({ budget_daily_usd: 180, conversions_30d: 50, bidding: {} });
  assert.match(g({ campaign_id: 'c1', new_daily_usd: 220 }, rich), /ceiling/);
  const floorCtx = ctx(); floorCtx.campaign = () => ({ budget_daily_usd: 1.2, conversions_30d: 50, bidding: {} });
  assert.match(g({ campaign_id: 'c1', new_daily_usd: 0.9 }, floorCtx), /platform minimum/);
});

test('target: needs 30 conversions/30d and stays within ±20%', () => {
  const g = byId['ads.adjust_target'].guard;
  assert.strictEqual(g({ campaign_id: 'c1', value: 23 }, ctx()), null);
  assert.match(g({ campaign_id: 'c1', value: 25 }, ctx()), /20%/);
  assert.match(g({ campaign_id: 'c2', value: 10 }, ctx()), /30 conversions/);
});

test('enable only for campaigns we paused; drafts always paused; launch fully gated', () => {
  assert.strictEqual(byId['ads.enable_campaign'].guard({ campaign_id: 'c9' }, ctx()), null);
  assert.match(byId['ads.enable_campaign'].guard({ campaign_id: 'c1' }, ctx()), /we paused/);
  assert.match(byId['ads.create_campaign_draft'].guard({ spec: { status: 'enabled' } }, ctx()), /ALWAYS created paused/);
  assert.strictEqual(byId['ads.unpause_launch'].guard({ campaign_id: 'c5' }, ctx()), null);
  assert.match(byId['ads.unpause_launch'].guard({ campaign_id: 'c1' }, ctx()), /approval record/);
  const gateless = ctx(); gateless.gates = { tag: true, billing: false, approval: true };
  assert.match(byId['ads.unpause_launch'].guard({ campaign_id: 'c5' }, gateless), /launch gate/);
});

test('primary demotion never zeroes primaries; key events capped; link + retention pinned', () => {
  const solo = ctx(); solo.primaryActionCount = 1;
  assert.match(byId['ads.set_action_secondary'].guard({ conversion_action_id: 'a1' }, solo), /0 primary/);
  const full = ctx(); full.keyEventCount = 10;
  assert.match(byId['ga4.create_key_event'].guard({ property_id: 'p', event_name: 'e' }, full), /10 key events/);
  assert.match(byId['ga4.create_ads_link'].guard({ property_id: 'p', ads_cid: '999' }, ctx()), /linked asset/);
  assert.strictEqual(byId['ga4.create_ads_link'].guard({ property_id: 'p', ads_cid: '6424596144' }, ctx()), null);
  assert.match(byId['ga4.set_retention'].guard({ property_id: 'p', months: 2 }, ctx()), /14 months/);
});

test('gtm: staged workspace enforced, publish is its own approval scope', () => {
  assert.match(byId['gtm.update_tag_config'].guard({ container_id: 'c', tag_id: 't' }, ctx()), /staged workspace/);
  assert.strictEqual(byId['gtm.update_tag_config'].guard({ container_id: 'c', workspace_id: 'w', tag_id: 't' }, ctx()), null);
  assert.strictEqual(byId['gtm.publish'].guard({ workspace_id: 'w', changeset_id: 'cs1' }, ctx()), null);
  assert.match(byId['gtm.publish'].guard({ workspace_id: 'w', changeset_id: 'cs2' }, ctx()), /own approval scope/);
});
