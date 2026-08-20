// Layer 4b — RSA (responsive search ad) coverage and quality, plus
// campaign-build gap rules (agency-specialist audit P1). Same ctx.ads input
// as layer4-ads, extended at the fetch stage with per-ad-group RSA data:
//
// ctx.ads.ad_groups = [{ id, name, campaign_id, status,
//   rsas: [{ ad_id, strength ('EXCELLENT'|'GOOD'|'AVERAGE'|'POOR'|null),
//            headline_count, description_count, pinned_headlines, pinned_descriptions }] }]
// ctx.ads.has_brand_campaign / has_remarketing (assembled booleans) may be
// absent — build-gap rules then derive from campaign names.
//
// All thresholds from rule_config (15 seed).

const enabledGroups = (ads) => (ads.ad_groups || []).filter((g) => g.status === 'enabled');
const activeCampaignIds = (ads) => new Set((ads.campaigns || []).filter((c) => c.status === 'enabled').map((c) => String(c.id)));
const campaignById = (ads, id) => (ads.campaigns || []).find((c) => String(c.id) === String(id)) || {};

const rules = [
  {
    rule_id: 'rsa.missing',
    layer: 4,
    // An enabled ad group with zero RSAs serves nothing (ETAs are gone).
    run({ ads }) {
      const active = activeCampaignIds(ads);
      const bare = enabledGroups(ads).filter((g) => active.has(String(g.campaign_id)) && (g.rsas || []).length === 0);
      if (!bare.length) return [];
      return bare.map((g) => ({
        category: 'coverage_gap',
        entity_key: `adgroup:${g.id}`,
        evidence: { metrics: { rsa_count: 0 }, window_days: 0, queries: ['ads/rsa/missing@v1'] },
        payload: {
          locked: true,
          entities: [{ kind: 'ad_group', value: g.name }],
          campaign_ref: String(g.campaign_id),
          campaign_name: campaignById(ads, g.campaign_id).name || null,
          fix_detail: `Ad group "${g.name}" has no responsive search ad at all — its keywords can't serve. Draft an RSA (we generate one from the keywords) or pause the group.`,
        },
        icon: 'file-x',
      }));
    },
  },

  {
    rule_id: 'rsa.thin_assets',
    layer: 4,
    // Too few headlines/descriptions caps combinations and ad strength.
    run({ ads, thresholds }) {
      const minH = thresholds.min_headlines ?? 8;
      const minD = thresholds.min_descriptions ?? 3;
      const active = activeCampaignIds(ads);
      const out = [];
      for (const g of enabledGroups(ads)) {
        if (!active.has(String(g.campaign_id))) continue;
        for (const rsa of g.rsas || []) {
          if (rsa.headline_count >= minH && rsa.description_count >= minD) continue;
          out.push({
            category: 'coverage_gap',
            entity_key: `rsa:${rsa.ad_id}:thin`,
            evidence: {
              metrics: { headline_count: rsa.headline_count, description_count: rsa.description_count, min_headlines: minH, min_descriptions: minD },
              window_days: 0,
              queries: ['ads/rsa/thin@v1'],
            },
            payload: {
              locked: true,
              entities: [{ kind: 'ad_group', value: g.name }],
              campaign_ref: String(g.campaign_id),
              campaign_name: campaignById(ads, g.campaign_id).name || null,
              fix_detail: `RSA in "${g.name}" runs ${rsa.headline_count} headlines / ${rsa.description_count} descriptions (recommended ${minH}+/${minD}+). Fewer assets = fewer combinations Google can test = weaker serving.`,
            },
            icon: 'layers',
          });
        }
      }
      return out;
    },
  },

  {
    rule_id: 'rsa.over_pinned',
    layer: 4,
    // Pinning every position turns an RSA back into a static ad.
    run({ ads, thresholds }) {
      const maxPinned = thresholds.max_pinned ?? 2;
      const active = activeCampaignIds(ads);
      const out = [];
      for (const g of enabledGroups(ads)) {
        if (!active.has(String(g.campaign_id))) continue;
        for (const rsa of g.rsas || []) {
          const pins = (rsa.pinned_headlines || 0) + (rsa.pinned_descriptions || 0);
          if (pins <= maxPinned) continue;
          out.push({
            category: 'performance_drag',
            entity_key: `rsa:${rsa.ad_id}:pinned`,
            evidence: { metrics: { pinned_total: pins, max_recommended: maxPinned }, window_days: 0, queries: ['ads/rsa/pinned@v1'] },
            payload: {
              locked: true,
              entities: [{ kind: 'ad_group', value: g.name }],
              campaign_ref: String(g.campaign_id),
              campaign_name: campaignById(ads, g.campaign_id).name || null,
              fix_detail: `RSA in "${g.name}" pins ${pins} assets — Google can barely rotate combinations, which suppresses serving. Unpin all but the compliance-critical ones.`,
            },
            icon: 'pin',
          });
        }
      }
      return out;
    },
  },

  {
    rule_id: 'rsa.poor_strength',
    layer: 4,
    // Google's own strength verdict on a serving ad.
    run({ ads }) {
      const active = activeCampaignIds(ads);
      const out = [];
      for (const g of enabledGroups(ads)) {
        if (!active.has(String(g.campaign_id))) continue;
        for (const rsa of g.rsas || []) {
          if (rsa.strength !== 'POOR') continue;
          out.push({
            category: 'performance_drag',
            entity_key: `rsa:${rsa.ad_id}:strength`,
            evidence: { metrics: { strength: 'POOR' }, window_days: 0, queries: ['ads/rsa/strength@v1'] },
            payload: {
              locked: true,
              entities: [{ kind: 'ad_group', value: g.name }],
              campaign_ref: String(g.campaign_id),
              campaign_name: campaignById(ads, g.campaign_id).name || null,
              fix_detail: `Google rates the RSA in "${g.name}" as Poor — usually duplicate-ish headlines or missing keyword relevance. We can draft replacement assets from the ad group's keywords.`,
            },
            icon: 'trending-down',
          });
        }
      }
      return out;
    },
  },

  // ---- Build-gap rules: findings that suggest a campaign BUILD. The fix is
  // a draft from packages/campaigns; it ships through the normal approval
  // path and is always created paused.
  {
    rule_id: 'ads.missing_brand_campaign',
    layer: 4,
    run({ ads, thresholds }) {
      const minSpend = thresholds.min_spend_30d_usd ?? 300;
      if ((ads.spend_30d_usd || 0) < minSpend) return [];
      const names = (ads.campaigns || []).filter((c) => c.status === 'enabled').map((c) => (c.name || '').toLowerCase());
      if (!names.length) return [];
      const hasBrand = ads.has_brand_campaign != null ? ads.has_brand_campaign : names.some((n) => n.includes('brand'));
      if (hasBrand) return [];
      return [{
        category: 'coverage_gap',
        entity_key: `${ads.customer_id}:no_brand`,
        money: { impact_monthly_usd: Math.round((ads.spend_30d_usd || 0) * 0.05), direction: 'opportunity', confidence: 'estimated' },
        evidence: { metrics: { enabled_campaigns: names.length, brand_campaigns: 0 }, window_days: 30, queries: ['ads/build/brand@v1'] },
        payload: {
          locked: true,
          entities: [{ kind: 'account', value: String(ads.customer_id) }],
          build_template: 'brand',
          fix_detail: 'No brand campaign: people searching this business by name see competitors bidding on it. Brand clicks are the cheapest in the account. Draft ready — one ad group, exact+phrase brand terms, created paused.',
        },
        icon: 'plus-circle',
      }];
    },
  },

  {
    rule_id: 'ads.missing_remarketing',
    layer: 4,
    run({ ads, thresholds }) {
      const minSpend = thresholds.min_spend_30d_usd ?? 1000;
      if ((ads.spend_30d_usd || 0) < minSpend) return [];
      const has = ads.has_remarketing != null ? ads.has_remarketing
        : (ads.campaigns || []).some((c) => c.status === 'enabled' && /remarket|retarget/i.test(c.name || ''));
      if (has) return [];
      return [{
        category: 'coverage_gap',
        entity_key: `${ads.customer_id}:no_remarketing`,
        money: { impact_monthly_usd: Math.round((ads.spend_30d_usd || 0) * 0.03), direction: 'opportunity', confidence: 'estimated' },
        evidence: { metrics: { remarketing_campaigns: 0 }, window_days: 30, queries: ['ads/build/remarketing@v1'] },
        payload: {
          locked: true,
          entities: [{ kind: 'account', value: String(ads.customer_id) }],
          build_template: 'remarketing',
          fix_detail: 'Paid visitors who didn\'t convert are gone for good — no remarketing campaign exists. Draft ready: 30-day site visitors, created paused.',
        },
        icon: 'plus-circle',
      }];
    },
  },
];

module.exports = { rules };
