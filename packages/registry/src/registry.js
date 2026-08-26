// The change registry — engine-spec §4.1. Every finding type maps to exactly
// one change shape, executed by the existing tool surface. This is data
// (like rule_config), kept in the repo so tunings arrive as PRs (§11.9).
// Adding an optimisation = adding a row + tests, not new machinery.
//
// Row contract:
//   rule_id      the finding this row answers
//   tool_id      catalogue tool (packages/tools/src/catalogue.js)
//   category     autopilot category: 'negatives' | 'budgets' | 'counting' | null (= always ask)
//   watch        { kind, days } — the verification watch opened on apply (§4.4)
//   derive(finding, ctx) -> [{ params, target, before, after, summary }]
//                the deterministic param derivation. Returns [] when the
//                finding lacks what a safe change needs (finding stays brief-only).
//                `target` is the canonical resource key (one change in flight per resource, §7.3).
//   rollback(change) -> { tool_id, params } | null   (null = irreversible; ask-first only, never autopilot)
//   baseline(finding, ctx) -> {}  metrics captured at apply time for the watch's effect measurement
//
// ctx is the run ctx: { ads, adsDeep, ga4, gtm, ... } (see apps/worker/src/stages.js).

const NEG_MAX_PER_CHANGE = 25; // §4.2

const r2 = (n) => Math.round(n * 100) / 100;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

function campaignById(ctx, id) {
  return ((ctx.ads && ctx.ads.campaigns) || []).find((c) => String(c.id) === String(id)) || null;
}

/** Group wasted/foreign/out-of-area search terms into ≤25-term negative changes per campaign. */
function negativeChanges(finding, ctx, label) {
  const entities = (finding.payload && finding.payload.entities) || [];
  const byCampaign = new Map();
  for (const e of entities) {
    const term = String(e.value || '').trim();
    if (!term) continue;
    // deep rules omit campaign_id on entities; the term list carries it (§3 shape)
    const cid = e.campaign_id || termCampaign(ctx, term);
    if (!cid) continue;
    if (!byCampaign.has(cid)) byCampaign.set(cid, []);
    byCampaign.get(cid).push({ text: term, match_type: 'exact', spend_usd: e.spend_usd || 0 });
  }
  const out = [];
  for (const [cid, terms] of byCampaign) {
    const sorted = terms.sort((a, b) => (b.spend_usd || 0) - (a.spend_usd || 0)).slice(0, NEG_MAX_PER_CHANGE);
    const c = campaignById(ctx, cid);
    const spend = sorted.reduce((s, t) => s + (t.spend_usd || 0), 0);
    out.push({
      params: { campaign_id: String(cid), terms: sorted.map((t) => ({ text: t.text, match_type: t.match_type })) },
      target: `campaign:${cid}:negatives`,
      before: { line: `${sorted.length} ${label} search${sorted.length === 1 ? '' : 'es'} still trigger ads${c ? ` in "${c.name}"` : ''} (${usd(spend)} over 90 days)` },
      after: { line: `Those searches are excluded; every other search keeps running` },
      summary: `Excluded ${sorted.length} ${label} search${sorted.length === 1 ? '' : 'es'}${c ? ` from "${c.name}"` : ''}`,
      money_impact_usd: r2(spend / 3),
    });
  }
  return out;
}

function termCampaign(ctx, term) {
  const t = ((ctx.ads && ctx.ads.search_terms) || []).find((s) => s.term === term);
  return t ? t.campaign_id : null;
}

function negativesRollback(change) {
  const names = change.after && Array.isArray(change.after.resource_names) ? change.after.resource_names : [];
  if (!names.length) return null;
  return { tool_id: 'ads.remove_negative_keywords', params: { campaign_id: change.params.campaign_id, resource_names: names } };
}

function negBaseline(finding, ctx) {
  const terms = new Set(((finding.payload && finding.payload.entities) || []).map((e) => e.value));
  const rows = ((ctx.ads && ctx.ads.search_terms) || []).filter((t) => terms.has(t.term));
  return {
    blocked_terms_spend_90d_usd: r2(rows.reduce((s, t) => s + (t.spend_90d_usd || 0), 0)),
    account_conversions_30d: (ctx.ads && ctx.ads.ads_conversions_30d) || 0,
  };
}

const NEG_WATCH = { kind: 'negatives', days: 7 };
const BUDGET_WATCH = { kind: 'budgets', days: 14 };
const COUNTING_WATCH = { kind: 'counting', days: 2 };

function budgetChange(finding, ctx, direction) {
  const c = campaignById(ctx, finding.entity_key);
  if (!c || !c.budget_resource || !(c.budget_daily_usd > 0)) return [];
  const pct = direction === 'raise' ? 0.2 : -0.2; // bounds.js enforces the ceiling again
  const next = r2(Math.max(5, c.budget_daily_usd * (1 + pct)));
  if (next === c.budget_daily_usd) return [];
  return [{
    params: { campaign_id: String(c.id), budget_resource: c.budget_resource, new_daily_usd: next, previous_daily_usd: c.budget_daily_usd },
    target: `campaign:${c.id}:budget`,
    before: { line: `"${c.name}" runs on ${usd(c.budget_daily_usd)} a day` },
    after: { line: `"${c.name}" runs on ${usd(next)} a day (${direction === 'raise' ? 'up' : 'down'} 20%)` },
    summary: `${direction === 'raise' ? 'Raised' : 'Lowered'} "${c.name}" daily budget ${usd(c.budget_daily_usd)} → ${usd(next)}`,
    money_impact_usd: finding.money ? finding.money.impact_monthly_usd : null,
  }];
}

function budgetRollback(change) {
  const p = change.params || {};
  if (!p.budget_resource || !(p.previous_daily_usd > 0)) return null;
  return { tool_id: 'ads.adjust_budget', params: { campaign_id: p.campaign_id, budget_resource: p.budget_resource, new_daily_usd: p.previous_daily_usd, previous_daily_usd: p.new_daily_usd } };
}

function budgetBaseline(finding, ctx) {
  const c = campaignById(ctx, finding.entity_key);
  return c ? { spend_30d_usd: c.spend_30d_usd, conversions_30d: c.conversions_30d, cpa_30d_usd: c.conversions_30d > 0 ? r2(c.spend_30d_usd / c.conversions_30d) : null, budget_daily_usd: c.budget_daily_usd } : {};
}

const ROWS = [
  // ---------------------------------------------------------------- negatives
  { rule_id: 'ads.wasted_terms', tool_id: 'ads.add_negative_keywords', category: 'negatives', watch: NEG_WATCH,
    derive: (f, ctx) => negativeChanges(f, ctx, 'wasted'), rollback: negativesRollback, baseline: negBaseline },
  { rule_id: 'ads.competitor_name_drift', tool_id: 'ads.add_negative_keywords', category: 'negatives', watch: NEG_WATCH,
    derive: (f, ctx) => negativeChanges(f, ctx, 'competitor-name'), rollback: negativesRollback, baseline: negBaseline },
  { rule_id: 'ads.out_of_area', tool_id: 'ads.add_negative_keywords', category: 'negatives', watch: NEG_WATCH,
    derive: (f, ctx) => negativeChanges(f, ctx, 'out-of-area'), rollback: negativesRollback, baseline: negBaseline },
  { rule_id: 'ads.off_menu_queries', tool_id: 'ads.add_negative_keywords', category: 'negatives', watch: NEG_WATCH,
    derive: (f, ctx) => negativeChanges(f, ctx, 'off-menu'), rollback: negativesRollback, baseline: negBaseline },

  // ---------------------------------------------------------------- budgets (reallocate-only; bounds.js pairs raises with cuts)
  { rule_id: 'ads.budget_constrained_winner', tool_id: 'ads.adjust_budget', category: 'budgets', watch: BUDGET_WATCH,
    derive: (f, ctx) => budgetChange(f, ctx, 'raise'), rollback: budgetRollback, baseline: budgetBaseline },
  { rule_id: 'ads.budget_bleeding_loser', tool_id: 'ads.adjust_budget', category: 'budgets', watch: BUDGET_WATCH,
    derive: (f, ctx) => budgetChange(f, ctx, 'cut'), rollback: budgetRollback, baseline: budgetBaseline },

  // ---------------------------------------------------------------- counting
  { rule_id: 'ads.dual_primary', tool_id: 'ads.set_action_secondary', category: 'counting', watch: COUNTING_WATCH,
    derive(f, ctx) {
      // Keep the first-listed primary action; demote the rest to secondary.
      const names = ((f.payload && f.payload.entities) || []).map((e) => e.value);
      const actions = ((ctx.ads && ctx.ads.conversion_actions) || []).filter((a) => names.includes(a.name) && a.primary);
      return actions.slice(1).map((a) => ({
        params: { conversion_action_id: String(a.id) },
        target: `conversion_action:${a.id}:primary`,
        before: { line: `"${a.name}" and "${actions[0].name}" both count as primary — the same customer is counted twice` },
        after: { line: `"${a.name}" becomes secondary; "${actions[0].name}" stays the one that counts` },
        summary: `Set "${a.name}" to secondary (double counting removed)`,
        money_impact_usd: null,
      }));
    },
    rollback: (change) => ({ tool_id: 'ads.set_action_primary', params: { conversion_action_id: change.params.conversion_action_id } }),
    baseline: (f, ctx) => ({ conversions_30d: (ctx.ads && ctx.ads.ads_conversions_30d) || 0, ga4_key_events_30d: (ctx.ads && ctx.ads.ga4_key_events_30d) || null }),
  },
  { rule_id: 'ga4.retention_short', tool_id: 'ga4.set_retention', category: null, watch: COUNTING_WATCH,
    derive: (f, ctx) => (ctx.ga4 && ctx.ga4.property_id ? [{
      params: { property_id: String(ctx.ga4.property_id), months: 14 }, target: `property:${ctx.ga4.property_id}:retention`,
      before: { line: `Visitor history is kept for ${ctx.ga4.retention_months} months` }, after: { line: 'Visitor history is kept for 14 months (the maximum, free)' },
      summary: 'Set data retention to 14 months', money_impact_usd: null,
    }] : []),
    rollback: () => null, baseline: () => ({}),
  },
  { rule_id: 'ga4.ads_link_missing', tool_id: 'ga4.create_ads_link', category: null, watch: COUNTING_WATCH,
    derive: (f, ctx) => (ctx.ga4 && ctx.ga4.property_id && ctx.ads && ctx.ads.customer_id ? [{
      params: { property_id: String(ctx.ga4.property_id), ads_cid: String(ctx.ads.customer_id) }, target: `property:${ctx.ga4.property_id}:ads_link`,
      before: { line: 'Your visit tracking and your ads account are not connected' }, after: { line: 'Tracking is linked to your ads account, so what happens after the click reaches Google Ads' },
      summary: 'Linked tracking to the ads account', money_impact_usd: null,
    }] : []),
    rollback: () => null, baseline: () => ({}),
  },

  // ---------------------------------------------------------------- ask-first only (never autopilot, §4.3)
  { rule_id: 'qs.nonconverter_floor', tool_id: 'ads.pause_keyword', category: null, watch: NEG_WATCH,
    derive(f, ctx) {
      const keys = new Set(((f.payload && f.payload.entities) || []).map((e) => String(e.value)));
      return ((ctx.adsDeep && ctx.adsDeep.keywords) || [])
        .filter((k) => keys.has(`${k.keyword} (${k.match})`) && k.ad_group_id && k.criterion_id)
        .map((k) => ({
          params: { ad_group_id: k.ad_group_id, criterion_id: k.criterion_id, keyword: k.keyword },
          target: `keyword:${k.ad_group_id}~${k.criterion_id}`,
          before: { line: `"${k.keyword}" runs at the lowest quality rating and has never booked (${usd(k.cost_usd)} over 90 days)` },
          after: { line: `"${k.keyword}" is paused; nothing else changes` },
          summary: `Paused keyword "${k.keyword}"`,
          money_impact_usd: r2(k.cost_usd / 3),
        }));
    },
    rollback: (change) => ({ tool_id: 'ads.enable_keyword', params: { ad_group_id: change.params.ad_group_id, criterion_id: change.params.criterion_id } }),
    baseline: (f, ctx) => ({ account_conversions_30d: (ctx.ads && ctx.ads.ads_conversions_30d) || 0 }),
  },
  { rule_id: 'ads.tcpa_blind', tool_id: 'ads.pause_campaign', category: null, watch: BUDGET_WATCH,
    derive(f, ctx) {
      const c = campaignById(ctx, f.entity_key);
      if (!c) return [];
      return [{
        params: { campaign_id: String(c.id) }, target: `campaign:${c.id}:status`,
        before: { line: `"${c.name}" spends ${usd(c.spend_30d_usd)} a month on a cost target with no conversions arriving` },
        after: { line: `"${c.name}" is paused until counting is fixed; one tap turns it back on` },
        summary: `Paused "${c.name}"`, money_impact_usd: f.money ? f.money.impact_monthly_usd : null,
      }];
    },
    rollback: (change) => ({ tool_id: 'ads.enable_campaign', params: { campaign_id: change.params.campaign_id } }),
    baseline: budgetBaseline,
  },

  // ---------------------------------------------------------------- watch-fed (§4.4): the regressed watch proposes the rollback, ask-first
  { rule_id: 'watch.change_regressed', tool_id: null, category: null, watch: null,
    derive(f) {
      const rb = f.payload && f.payload.rollback;
      if (!rb || !rb.tool_id) return [];
      return [{
        params: rb.params, tool_id: rb.tool_id, target: `${rb.target || 'change'}:rollback`,
        before: { line: f.payload.before_line || 'The change we made did not deliver' },
        after: { line: f.payload.after_line || 'The change is undone and the account returns to how it was' },
        summary: f.payload.summary || 'Undid a change that did not deliver', money_impact_usd: null,
        reverts_change_id: f.payload.change_id,
      }];
    },
    rollback: () => null, baseline: () => ({}),
  },
];

const byRule = Object.fromEntries(ROWS.map((r) => [r.rule_id, r]));
const byTool = (toolId) => ROWS.find((r) => r.tool_id === toolId) || null;

module.exports = { ROWS, byRule, byTool, NEG_MAX_PER_CHANGE, negativeChanges, budgetChange };
