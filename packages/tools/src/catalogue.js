// The constrained tool catalogue — build-doc §4, master §3.1.
// THE ONLY write surface in the system. Every tool: typed params, guardrails
// in CODE (not prompts, not config), before/after diff, idempotency key,
// ledger entry. No free-form API composition anywhere.
//
// Each tool: {
//   tool_id,
//   entities(params)            -> how many entities this change touches (circuit breaker input)
//   guard(params, ctx)          -> null | 'reason string'   (pure, no I/O)
// }
// Execution transport is injected into the executor (executor.js); the
// catalogue is pure so every guardrail unit-tests without a network.
//
// ctx provided by the run assembling the changeset:
//   ctx.account = { daily_budget_total_usd, weekly_budget_delta_pct, platform_min_daily_usd }
//   ctx.campaign(params.campaign_id) = { budget_daily_usd, conversions_30d, bidding: {target} }
//   ctx.convertingTerms   Set of search terms with conversions (negative blocklist)
//   ctx.pausedByUs        Set of campaign_ids the ledger says WE paused
//   ctx.pausedKeywordsByUs Set of 'ad_group_id~criterion_id' WE paused; ctx.negativesByUs Set of criterion resource names WE added
//   ctx.primaryActionCount, ctx.keyEventCount
//   ctx.linkedAdsCustomerIds  confirmed ads asset external_ids
//   ctx.approvals         [{ scope, target_id }]
//   ctx.gates             { tag, billing, approval }  (Journey B launch gate)

const num = (v) => typeof v === 'number' && Number.isFinite(v);

const TOOLS = [
  {
    tool_id: 'ads.add_negative_keywords',
    entities: (p) => (p.terms || []).length,
    guard(p, ctx) {
      if (!p.campaign_id || !Array.isArray(p.terms) || p.terms.length === 0) return 'campaign_id and terms[] required';
      if (p.terms.length > 200) return 'guardrail: more than 200 negative terms in one run';
      const badMatch = p.terms.find((t) => !['exact', 'phrase'].includes(t.match_type));
      if (badMatch) return `guardrail: match type "${badMatch.match_type}" not allowed — exact and phrase only`;
      const converting = p.terms.find((t) => ctx.convertingTerms && ctx.convertingTerms.has(t.text));
      if (converting) return `guardrail: "${converting.text}" has conversions — refusing to negative a converting term`;
      return null;
    },
  },
  {
    // Rollback of add_negative_keywords: removes exactly the criteria we created
    // (resource names captured in the applied change's `after`).
    tool_id: 'ads.remove_negative_keywords',
    entities: (p) => (p.resource_names || []).length,
    guard(p, ctx) {
      if (!p.campaign_id || !Array.isArray(p.resource_names) || p.resource_names.length === 0) return 'campaign_id and resource_names[] required';
      if (p.resource_names.length > 200) return 'guardrail: more than 200 criteria in one run';
      const bad = p.resource_names.find((r) => !/^customers\/\d+\/campaignCriteria\/\d+~\d+$/.test(String(r)));
      if (bad) return `guardrail: "${bad}" is not a campaign criterion resource name`;
      if (ctx.negativesByUs && !p.resource_names.every((r) => ctx.negativesByUs.has(r))) return 'guardrail: only negatives we added can be removed (ledger check)';
      return null;
    },
  },
  {
    tool_id: 'ads.adjust_budget',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.campaign_id || !num(p.new_daily_usd)) return 'campaign_id and new_daily_usd required';
      const c = ctx.campaign(p.campaign_id);
      if (!c) return 'unknown campaign';
      const deltaPct = Math.abs(p.new_daily_usd - c.budget_daily_usd) / c.budget_daily_usd * 100;
      if (deltaPct > 25) return `guardrail: ±25%/run per campaign exceeded (${Math.round(deltaPct)}%)`;
      if (Math.abs(ctx.account.weekly_budget_delta_pct || 0) + deltaPct > 40) return 'guardrail: ±40% account/week exceeded';
      if (p.new_daily_usd > 2 * ctx.account.daily_budget_total_usd) return 'guardrail: absolute ceiling (2x account daily total) exceeded';
      if (p.new_daily_usd < (ctx.account.platform_min_daily_usd || 1)) return 'guardrail: below platform minimum';
      return null;
    },
  },
  {
    tool_id: 'ads.adjust_target',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.campaign_id || !num(p.value)) return 'campaign_id and value required';
      const c = ctx.campaign(p.campaign_id);
      if (!c) return 'unknown campaign';
      if ((c.conversions_30d || 0) < 30) return 'guardrail: target changes need >=30 conversions in 30d';
      const cur = c.bidding && c.bidding.target;
      if (num(cur) && Math.abs(p.value - cur) / cur * 100 > 20) return 'guardrail: ±20%/run target change exceeded';
      return null;
    },
  },
  {
    tool_id: 'ads.pause_campaign',
    entities: () => 1,
    guard: (p) => (p.campaign_id ? null : 'campaign_id required'),
  },
  {
    tool_id: 'ads.enable_campaign',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.campaign_id) return 'campaign_id required';
      if (!ctx.pausedByUs || !ctx.pausedByUs.has(p.campaign_id)) return 'guardrail: enable only allowed for campaigns we paused (ledger check)';
      return null;
    },
  },
  {
    tool_id: 'ads.pause_keyword',
    entities: () => 1,
    guard: (p) => (p.ad_group_id && p.criterion_id ? null : 'ad_group_id and criterion_id required'),
  },
  {
    // Rollback of pause_keyword — only for keywords the ledger says WE paused.
    tool_id: 'ads.enable_keyword',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.ad_group_id || !p.criterion_id) return 'ad_group_id and criterion_id required';
      const key = `${p.ad_group_id}~${p.criterion_id}`;
      if (!ctx.pausedKeywordsByUs || !ctx.pausedKeywordsByUs.has(key)) return 'guardrail: enable only allowed for keywords we paused (ledger check)';
      return null;
    },
  },
  {
    tool_id: 'ads.set_action_secondary',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.conversion_action_id) return 'conversion_action_id required';
      if ((ctx.primaryActionCount || 0) <= 1) return 'guardrail: never leaves the account with 0 primary actions';
      return null;
    },
  },
  {
    tool_id: 'ads.set_action_primary',
    entities: () => 1,
    guard: (p) => (p.conversion_action_id ? null : 'conversion_action_id required'),
  },
  {
    tool_id: 'ads.create_campaign_draft',
    entities: () => 1,
    guard(p) {
      if (!p.spec) return 'spec required';
      if (p.spec.status && p.spec.status !== 'paused') return 'guardrail: campaign drafts are ALWAYS created paused';
      return null;
    },
  },
  {
    tool_id: 'ads.unpause_launch',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.campaign_id) return 'campaign_id required';
      const approved = (ctx.approvals || []).some((a) => a.scope === 'campaign_launch' && String(a.target_id) === String(p.campaign_id));
      if (!approved) return 'guardrail: launch requires an approval record with scope campaign_launch';
      const g = ctx.gates || {};
      if (!(g.tag && g.billing && g.approval)) return 'guardrail: launch gate needs tag, billing and approval all true';
      return null;
    },
  },
  {
    tool_id: 'ga4.create_key_event',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.property_id || !p.event_name) return 'property_id and event_name required';
      if ((ctx.keyEventCount || 0) >= 10) return 'guardrail: 10 key events maximum';
      return null;
    },
  },
  {
    tool_id: 'ga4.update_key_event',
    entities: () => 1,
    guard: (p) => (p.property_id && p.event_name ? null : 'property_id and event_name required'),
  },
  {
    tool_id: 'ga4.create_ads_link',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.property_id || !p.ads_cid) return 'property_id and ads_cid required';
      if (!(ctx.linkedAdsCustomerIds || []).map(String).includes(String(p.ads_cid))) {
        return "guardrail: ads_cid must match the tenant's linked asset";
      }
      return null;
    },
  },
  {
    tool_id: 'ga4.set_retention',
    entities: () => 1,
    guard(p) {
      if (!p.property_id) return 'property_id required';
      if (p.months !== 14) return 'guardrail: retention is set to 14 months, nothing else';
      return null;
    },
  },
  {
    tool_id: 'gtm.create_tag',
    entities: () => 1,
    guard: (p) => (p.container_id && p.workspace_id && p.spec ? null : 'guardrail: staged workspace required — never live edit'),
  },
  {
    tool_id: 'gtm.update_tag_config',
    entities: () => 1,
    guard: (p) => (p.container_id && p.workspace_id && p.tag_id ? null : 'guardrail: staged workspace required — never live edit'),
  },
  {
    tool_id: 'gtm.pause_tag',
    entities: () => 1,
    guard: (p) => (p.container_id && p.workspace_id && p.tag_id ? null : 'container_id, workspace_id and tag_id required'),
  },
  {
    tool_id: 'gtm.remove_tag',
    entities: () => 1,
    guard: (p) => (p.container_id && p.workspace_id && p.tag_id ? null : 'container_id, workspace_id and tag_id required'),
  },
  {
    tool_id: 'gtm.publish',
    entities: () => 1,
    guard(p, ctx) {
      if (!p.workspace_id) return 'workspace_id required';
      const approved = (ctx.approvals || []).some((a) => a.scope === 'changeset' && String(a.target_id) === String(p.changeset_id));
      if (!approved) return 'guardrail: publish is its own approval scope — no publish approval found';
      return null;
    },
  },
  {
    tool_id: 'gtm.restore_version_element',
    entities: () => 1,
    guard: (p) => (p.version_id && p.element ? null : 'version_id and element required'),
  },
];

const byId = Object.fromEntries(TOOLS.map((t) => [t.tool_id, t]));

module.exports = { TOOLS, byId };
