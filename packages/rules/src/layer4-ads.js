// Layer 4 — Ads closure rules (build-doc §3).
// The first layer where real money enters the findings: wasted_terms and the
// budget rules carry MEASURED monthly USD impact from actual spend data.
//
// Input shape (assembled at the fetch_ads pipeline stage, §8):
//
// ctx.ads = {
//   customer_id, currency,
//   spend_30d_usd, spend_90d_usd,
//   conversion_actions: [{ id, name, primary, count_30d, last_conversion_at,
//                          source ('ga4_import'|'website'|'call'|...),
//                          ga4_event_name | null }],
//   campaigns: [{ id, name, status ('enabled'|'paused'),
//                 bidding: { strategy: 'tcpa'|'troas'|'max_conversions'|..., target },
//                 budget_daily_usd, budget_lost_is_pct,   // search budget lost IS
//                 spend_30d_usd, conversions_30d }],
//   search_terms: [{ term, campaign_id, spend_90d_usd, clicks_90d, conversions_90d }],
//   disapproved: [{ ad_id, ad_group, campaign_id, policy }],
//   ads_conversions_30d, ga4_key_events_30d,              // for divergence
// }
// ctx.silentGa4Events — Set/array of event names Layer 3 found silent (cause join)
// ctx.now — ms epoch, injected
//
// All thresholds from rule_config (08 seed); guardrails (≤200 negatives etc.)
// belong to the §4 tool layer, not here.

const DAY_MS = 86_400_000;

const activeCampaigns = (ads) => (ads.campaigns || []).filter((c) => c.status === 'enabled');
const primaries = (ads) => (ads.conversion_actions || []).filter((a) => a.primary);

function daysSince(iso, now) {
  return iso ? (now - Date.parse(iso)) / DAY_MS : Infinity;
}

/** Median CPA across enabled campaigns with conversions — the §3 comparator. */
function accountMedianCpa(ads) {
  const cpas = activeCampaigns(ads)
    .filter((c) => c.conversions_30d > 0)
    .map((c) => c.spend_30d_usd / c.conversions_30d)
    .sort((a, b) => a - b);
  if (!cpas.length) return null;
  const mid = Math.floor(cpas.length / 2);
  return cpas.length % 2 ? cpas[mid] : (cpas[mid - 1] + cpas[mid]) / 2;
}

const rules = [
  {
    rule_id: 'ads.no_conversion_tracking',
    layer: 4,
    // Journey C finding #1: spend with zero working conversion actions.
    run({ ads, thresholds }) {
      const minSpend = thresholds.min_spend_90d_usd ?? 100;
      if (ads.spend_90d_usd < minSpend) return [];
      const working = (ads.conversion_actions || []).some((a) => a.primary && a.count_30d > 0);
      if (working) return [];
      return [{
        category: 'broken_tracking',
        entity_key: ads.customer_id,
        money: { impact_monthly_usd: Math.round(ads.spend_90d_usd / 3), direction: 'waste', confidence: 'estimated' },
        evidence: {
          metrics: { spend_90d_usd: ads.spend_90d_usd, working_primary_actions: 0 },
          window_days: 90,
          queries: ['ads/rules/no_conversion_tracking@v1'],
        },
        payload: {
          locked: true,
          entities: [],
          fix_detail: "We'll build your complete measurement stack — included in your plan, live within days.",
        },
        icon: 'eye-off',
      }];
    },
  },

  {
    rule_id: 'ads.conversion_silent',
    layer: 4,
    // A primary action recording nothing 14+ days while campaigns spend.
    run({ ads, silentGa4Events, thresholds, now }) {
      const silentDays = thresholds.silent_days ?? 14;
      const spending = activeCampaigns(ads).some((c) => c.spend_30d_usd > 0);
      if (!spending) return [];
      const allPrimaries = primaries(ads);
      // System-defined (Google-hosted) actions are skipped: they are often
      // legitimately empty and the customer cannot configure them anyway.
      const silent = allPrimaries.filter((a) => !a.system_defined && a.count_30d === 0 && daysSince(a.last_conversion_at, now) >= silentDays);
      // Account-wide zero-working is ads.no_conversion_tracking's finding.
      if (!silent.length || silent.length === allPrimaries.length) return [];
      const silentEvents = new Set(silentGa4Events || []);
      return silent.map((a) => ({
        category: 'broken_tracking',
        entity_key: String(a.id),
        evidence: {
          metrics: { days_silent: Math.min(999, Math.floor(daysSince(a.last_conversion_at, now))) },
          window_days: 30,
          queries: ['ads/rules/conversion_silent@v1'],
        },
        payload: {
          locked: true,
          entities: [{
            kind: 'conversion_action',
            value: a.name,
            likely_cause: a.source === 'ga4_import' && a.ga4_event_name && silentEvents.has(a.ga4_event_name)
              ? 'ga4_event_silent' : 'action_config',
          }],
          fix_detail: `"${a.name}" has recorded nothing ${Number.isFinite(daysSince(a.last_conversion_at, now)) ? `for ${Math.floor(daysSince(a.last_conversion_at, now))}+ days` : 'in the last 30 days'} while your ads kept spending.`,
        },
        icon: 'bell-off',
      }));
    },
  },

  {
    rule_id: 'ads.tcpa_blind',
    layer: 4,
    // Smart-bidding campaign whose primary actions are all silent — bidding blind.
    // §3: the rule emits BOTH options (pause, or fix tracking first).
    run({ ads, thresholds, now }) {
      const silentDays = thresholds.silent_days ?? 14;
      const allSilent = primaries(ads).length > 0
        && primaries(ads).every((a) => a.count_30d === 0 && daysSince(a.last_conversion_at, now) >= silentDays);
      if (!allSilent) return [];
      return activeCampaigns(ads)
        .filter((c) => ['tcpa', 'troas', 'max_conversions', 'max_conversion_value'].includes(c.bidding && c.bidding.strategy))
        .filter((c) => c.spend_30d_usd > 0)
        .map((c) => ({
          category: 'wasted_spend',
          entity_key: String(c.id),
          money: { impact_monthly_usd: Math.round(c.spend_30d_usd), direction: 'waste', confidence: 'estimated' },
          evidence: {
            metrics: { spend_30d_usd: c.spend_30d_usd, silent_days: silentDays },
            window_days: 30,
            queries: ['ads/rules/tcpa_blind@v1'],
          },
          payload: {
            locked: true,
            entities: [{ kind: 'campaign', value: c.name, strategy: c.bidding.strategy }],
            fix_detail: `"${c.name}" lets Google bid automatically toward conversions — but no conversions have been recorded for ${silentDays}+ days, so it's optimising blind. Two ways out: pause it while we fix the tracking, or fix the tracking first and leave it running.`,
            options: [
              { tool_id: 'ads.pause_campaign', label: 'Pause while tracking is fixed' },
              { tool_id: null, label: 'Fix tracking first, leave running' },
            ],
          },
          fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
          icon: 'eye-off',
        }));
    },
  },

  {
    rule_id: 'ads.dual_primary',
    layer: 4,
    // Two primary actions counting the same conversion → double count.
    run({ ads }) {
      const byEvent = new Map();
      for (const a of primaries(ads)) {
        const key = a.ga4_event_name || null;
        if (!key) continue;
        if (!byEvent.has(key)) byEvent.set(key, []);
        byEvent.get(key).push(a);
      }
      const out = [];
      for (const [event, actions] of byEvent) {
        if (actions.length < 2) continue;
        out.push({
          category: 'double_counting',
          entity_key: event,
          evidence: {
            metrics: { primary_actions_on_event: actions.length },
            window_days: 30,
            queries: ['ads/rules/dual_primary@v1'],
          },
          payload: {
            locked: true,
            entities: actions.map((a) => ({ kind: 'conversion_action', value: a.name })),
            fix_detail: `${actions.length} customer-action counters record the same thing — every real conversion is counted ${actions.length} times, and bidding optimises to inflated numbers. Keep one, demote the rest.`,
          },
          fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
          icon: 'copy',
        });
      }
      return out;
    },
  },

  {
    rule_id: 'ads.divergence',
    layer: 4,
    // Ads vs GA4 conversions beyond attribution tolerance. Diagnostic.
    run({ ads, thresholds }) {
      const tolerancePct = thresholds.tolerance_pct ?? 40;
      const minVolume = thresholds.min_conversions ?? 10;
      const a = ads.ads_conversions_30d; const g = ads.ga4_key_events_30d;
      if (a == null || g == null || Math.max(a, g) < minVolume) return [];
      const divergence = Math.round((Math.abs(a - g) / Math.max(a, g)) * 100);
      if (divergence <= tolerancePct) return [];
      return [{
        category: 'suspicious_numbers',
        entity_key: ads.customer_id,
        evidence: {
          metrics: { ads_conversions_30d: a, ga4_key_events_30d: g, divergence_pct: divergence },
          window_days: 30,
          queries: ['ads/rules/divergence@v1'],
        },
        payload: {
          locked: true,
          entities: [],
          fix_detail: `Your two counting systems disagree by ${divergence}% — some difference is normal, this much means one of them is wrong.`,
        },
        icon: 'scale',
      }];
    },
  },

  {
    rule_id: 'ads.wasted_terms',
    layer: 4,
    // THE money rule: search terms with spend, zero conversions — measured waste.
    run({ ads, thresholds }) {
      const minTermSpend = thresholds.min_term_spend_90d_usd ?? 5;
      const minTotalSpend = thresholds.min_total_spend_90d_usd ?? 50;
      const wasted = (ads.search_terms || [])
        .filter((t) => t.conversions_90d === 0 && t.spend_90d_usd >= minTermSpend)
        .sort((a, b) => b.spend_90d_usd - a.spend_90d_usd);
      const total90 = wasted.reduce((s, t) => s + t.spend_90d_usd, 0);
      if (!wasted.length || total90 < minTotalSpend) return [];
      const monthly = Math.round(total90 / 3);
      return [{
        category: 'wasted_spend',
        entity_key: 'wasted_terms',
        money: { impact_monthly_usd: monthly, direction: 'waste', confidence: 'measured' },
        evidence: {
          metrics: {
            term_count: wasted.length,
            spend_90d_usd: Math.round(total90 * 100) / 100,
            conversions_90d: 0,
          },
          window_days: 90,
          queries: ['ads/rules/wasted_terms@v1'],
        },
        payload: {
          locked: true, // the $20 blur: the exact term list
          entities: wasted.map((t) => ({
            kind: 'search_term', value: t.term, spend_usd: t.spend_90d_usd, clicks: t.clicks_90d, campaign_id: t.campaign_id,
          })),
          fix_detail: `Add ${wasted.length} negative keywords; list attached.`,
        },
        fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
        icon: 'trending-down',
      }];
    },
  },

  {
    rule_id: 'ads.budget_constrained_winner',
    layer: 4,
    // Hitting budget cap with CPA below account median — money left on the table.
    run({ ads, thresholds }) {
      const minLostIs = thresholds.min_budget_lost_is_pct ?? 10;
      const minConversions = thresholds.min_conversions_30d ?? 3;
      const median = accountMedianCpa(ads);
      if (median == null) return [];
      return activeCampaigns(ads)
        .filter((c) => c.conversions_30d >= minConversions
          && (c.budget_lost_is_pct || 0) >= minLostIs
          && c.spend_30d_usd / c.conversions_30d < median)
        .map((c) => {
          const cpa = c.spend_30d_usd / c.conversions_30d;
          // Opportunity ≈ conversions recoverable at current CPA from lost IS.
          const upliftUsd = Math.round(c.spend_30d_usd * (c.budget_lost_is_pct / 100));
          return {
            category: 'opportunity',
            entity_key: String(c.id),
            money: { impact_monthly_usd: upliftUsd, direction: 'opportunity', confidence: 'estimated' },
            evidence: {
              metrics: {
                cpa_30d_usd: Math.round(cpa * 100) / 100,
                account_median_cpa_usd: Math.round(median * 100) / 100,
                budget_lost_is_pct: c.budget_lost_is_pct,
              },
              window_days: 30,
              queries: ['ads/rules/budget_constrained_winner@v1'],
            },
            payload: {
              locked: true,
              entities: [{ kind: 'campaign', value: c.name, budget_daily_usd: c.budget_daily_usd }],
              fix_detail: `"${c.name}" wins customers cheaper than your average but runs out of budget ${c.budget_lost_is_pct}% of the time — a modest raise buys more of your best traffic.`,
            },
            fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
            icon: 'trending-up',
          };
        });
    },
  },

  {
    rule_id: 'ads.budget_bleeding_loser',
    layer: 4,
    // Spending with CPA > 2× median, or zero conversions on real spend.
    run({ ads, thresholds }) {
      const minSpend = thresholds.min_spend_30d_usd ?? 100;
      const cpaMultiple = thresholds.cpa_multiple ?? 2;
      const median = accountMedianCpa(ads);
      return activeCampaigns(ads)
        .filter((c) => c.spend_30d_usd >= minSpend)
        .filter((c) => c.conversions_30d === 0
          || (median != null && c.spend_30d_usd / c.conversions_30d > cpaMultiple * median))
        .map((c) => {
          const zero = c.conversions_30d === 0;
          const excess = zero
            ? c.spend_30d_usd
            : Math.round(c.spend_30d_usd - c.conversions_30d * (median * cpaMultiple));
          return {
            category: 'wasted_spend',
            entity_key: String(c.id),
            money: { impact_monthly_usd: Math.max(0, Math.round(excess)), direction: 'waste', confidence: 'measured' },
            evidence: {
              metrics: {
                spend_30d_usd: c.spend_30d_usd,
                conversions_30d: c.conversions_30d,
                account_median_cpa_usd: median == null ? 0 : Math.round(median * 100) / 100,
              },
              window_days: 30,
              queries: ['ads/rules/budget_bleeding_loser@v1'],
            },
            payload: {
              locked: true,
              entities: [{ kind: 'campaign', value: c.name }],
              fix_detail: zero
                ? `"${c.name}" spent $${Math.round(c.spend_30d_usd)} last month and brought in nothing measurable. Cut its budget or pause it.`
                : `"${c.name}" pays over ${cpaMultiple}× your average for each customer. Rein its budget in.`,
            },
            fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
            icon: 'trending-down',
          };
        });
    },
  },

  {
    rule_id: 'ads.disapproved_ads',
    layer: 4,
    // Disapproved/limited ads sitting in active campaigns. Brief.
    run({ ads }) {
      const activeIds = new Set(activeCampaigns(ads).map((c) => String(c.id)));
      const inActive = (ads.disapproved || []).filter((d) => activeIds.has(String(d.campaign_id)));
      if (!inActive.length) return [];
      return [{
        category: 'config_hygiene',
        entity_key: 'disapproved',
        evidence: {
          metrics: { disapproved_count: inActive.length },
          window_days: 0,
          queries: ['ads/rules/disapproved_ads@v1'],
        },
        payload: {
          locked: true,
          entities: inActive.map((d) => ({ kind: 'ad', value: String(d.ad_id), campaign_id: d.campaign_id, policy: d.policy })),
          fix_detail: `${inActive.length} ad(s) were rejected by Google and aren't showing — the campaigns around them keep running with less coverage.`,
        },
        icon: 'file-x',
      }];
    },
  },
];

module.exports = { rules, accountMedianCpa };
