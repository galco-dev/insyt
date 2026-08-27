// Campaign executor — engine-spec §5 / §10.3. Turns an approved canonical
// spec (builder.js) into a REAL Google Ads campaign, created PAUSED, through
// the Ads API mutate surface. Enabling is a separate tool call (ads.unpause_launch)
// behind the second explicit yes — never bundled here.
//
// Pure planning + injected I/O:
//   planMutations(spec, { customerId, finalUrl, geoTargetIds, languageIds }) -> ordered operation groups
//   createCampaignPaused({ spec, adsMutate, adsSearch, customerId, finalUrl }) -> { campaign_id, resources, warnings }
//
// Invariants enforced in code, not prompts:
//   - campaign status PAUSED, always (the catalogue guard refuses anything else upstream too)
//   - no broad match in v1 drafts (phrase/exact only) — spec §5
//   - final URLs must be http(s) on the tenant's site
//   - every created resource name is returned so enable/teardown are exact

const MATCH = { exact: 'EXACT', phrase: 'PHRASE', broad: 'BROAD' };

function stripMatch(text) {
  return String(text || '').replace(/^\[(.*)\]$/, '$1').replace(/^"(.*)"$/, '$1').trim();
}

function tmpName(kind, i) { return `customers/{cid}/${kind}/-${i}`; }

/** Resolve a human location to geo target constant ids via GAQL (first enabled match). */
async function resolveGeo(adsSearch, location) {
  if (!location || location === 'account default') return [];
  const q = `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.target_type, geo_target_constant.canonical_name
             FROM geo_target_constant WHERE geo_target_constant.name = '${String(location).replace(/'/g, "\\'")}' AND geo_target_constant.status = 'ENABLED' LIMIT 5`;
  const rows = await adsSearch(q).catch(() => []);
  const pref = ['City', 'Region', 'Province', 'State', 'Country', 'Country Region'];
  const sorted = rows.map((r) => r.geoTargetConstant).sort((a, b) => pref.indexOf(a.targetType) - pref.indexOf(b.targetType));
  return sorted.length ? [String(sorted[0].id)] : [];
}

/**
 * Build the ordered mutate plan. Temporary resource ids (negative numbers)
 * let one request create budget → campaign → criteria; ad groups, keywords
 * and ads follow with the real campaign id (kept in separate calls so a
 * partial failure is diagnosable and retriable).
 */
function planMutations(spec, { customerId, finalUrl, geoTargetIds = [], languageIds = ['1000'] }) {
  if (!spec || spec.settings.start_paused !== true) throw new Error('campaign drafts are ALWAYS created paused');
  if (!/^https?:\/\//.test(String(finalUrl || ''))) throw new Error('final URL must be an http(s) address on your site');
  const cid = String(customerId).replace(/-/g, '');
  const budgetTmp = `customers/${cid}/campaignBudgets/-1`;
  const campaignTmp = `customers/${cid}/campaigns/-2`;

  const campaignOps = [
    { campaignBudgetOperation: { create: { resourceName: budgetTmp, name: `${spec.name} budget`, amountMicros: String(Math.round(spec.budget_daily_usd * 1_000_000)), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaignTmp, name: spec.name, status: 'PAUSED',
      advertisingChannelType: spec.channel === 'display' ? 'DISPLAY' : 'SEARCH',
      campaignBudget: budgetTmp,
      maximizeConversions: {},
      networkSettings: spec.channel === 'display' ? { targetContentNetwork: true } : { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    } } },
    ...geoTargetIds.map((id) => ({ campaignCriterionOperation: { create: { campaign: campaignTmp, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } })),
    ...languageIds.map((id) => ({ campaignCriterionOperation: { create: { campaign: campaignTmp, language: { languageConstant: `languageConstants/${id}` } } } })),
  ];
  // campaign-level negatives: union of ad-group negatives (phrase), deduped
  const negatives = [...new Set(spec.ad_groups.flatMap((g) => g.negatives || []).map((n) => stripMatch(n).toLowerCase()).filter(Boolean))];
  const negativeOps = (campaignRes) => negatives.map((n) => ({ create: { campaign: campaignRes, negative: true, keyword: { text: n, matchType: 'PHRASE' } } }));

  const adGroupOps = (campaignRes) => spec.ad_groups.map((g) => ({ create: { name: g.name, campaign: campaignRes, status: 'ENABLED', type: spec.channel === 'display' ? 'DISPLAY_STANDARD' : 'SEARCH_STANDARD' } }));

  const keywordOps = (adGroupRes, g) => (g.keywords || []).map((k) => {
    const mt = MATCH[k.match] || 'PHRASE';
    if (mt === 'BROAD') throw new Error(`broad match is not allowed in a first draft ("${k.text}")`);
    return { create: { adGroup: adGroupRes, status: 'ENABLED', keyword: { text: stripMatch(k.text), matchType: mt } } };
  });

  const adOps = (adGroupRes, g) => {
    const pins = g.rsa.pinned || {};
    const pinFor = (text, kind) => {
      const entry = Object.entries(pins).find(([, v]) => v === text);
      if (!entry) return {};
      const m = /^(headline|description)_(\d)$/.exec(entry[0]);
      if (!m || m[1] !== kind) return {};
      return { pinnedField: `${kind.toUpperCase()}_${m[2]}` };
    };
    return [{ create: {
      adGroup: adGroupRes, status: 'ENABLED',
      ad: {
        finalUrls: [finalUrl],
        responsiveSearchAd: {
          headlines: g.rsa.headlines.map((h) => ({ text: h, ...pinFor(h, 'headline') })),
          descriptions: g.rsa.descriptions.map((d) => ({ text: d, ...pinFor(d, 'description') })),
        },
      },
    } }];
  };

  return { cid, campaignOps, negativeOps, adGroupOps, keywordOps, adOps, negatives };
}

async function createCampaignPaused({ spec, adsMutate, adsSearch, customerId, finalUrl, location = spec && spec.settings && spec.settings.geo }) {
  const geoTargetIds = adsSearch ? await resolveGeo(adsSearch, location) : [];
  const plan = planMutations(spec, { customerId, finalUrl, geoTargetIds });
  const warnings = [];
  if (!geoTargetIds.length && location && location !== 'account default') warnings.push(`Could not resolve "${location}" to a Google location — campaign created without a location limit; set one before enabling.`);

  // 1) budget + campaign (+ geo/language) in one atomic request
  const first = await adsMutate('googleAds', plan.campaignOps, { atomic: true });
  const results = (first.mutateOperationResponses || []);
  const campaignRes = (results.find((r) => r.campaignResult) || {}).campaignResult?.resourceName;
  const budgetRes = (results.find((r) => r.campaignBudgetResult) || {}).campaignBudgetResult?.resourceName;
  if (!campaignRes) throw new Error('campaign create returned no campaign resource');
  const campaignId = campaignRes.split('/').pop();

  const resources = { campaign: campaignRes, budget: budgetRes, ad_groups: [], keywords: [], ads: [], negatives: [] };

  // 2) campaign negatives
  const negOps = plan.negativeOps(campaignRes);
  if (negOps.length) {
    const r = await adsMutate('campaignCriteria', negOps);
    resources.negatives = (r.results || []).map((x) => x.resourceName);
  }

  // 3) ad groups, then keywords + ads per group
  const agRes = await adsMutate('adGroups', plan.adGroupOps(campaignRes));
  const adGroupNames = (agRes.results || []).map((x) => x.resourceName);
  for (let i = 0; i < spec.ad_groups.length; i++) {
    const g = spec.ad_groups[i]; const agr = adGroupNames[i];
    if (!agr) { warnings.push(`ad group "${g.name}" was not created`); continue; }
    resources.ad_groups.push(agr);
    const kw = plan.keywordOps(agr, g);
    if (kw.length) {
      const r = await adsMutate('adGroupCriteria', kw);
      resources.keywords.push(...(r.results || []).map((x) => x.resourceName));
    }
    const ad = await adsMutate('adGroupAds', plan.adOps(agr, g));
    resources.ads.push(...(ad.results || []).map((x) => x.resourceName));
  }

  return { campaign_id: campaignId, resources, geo_target_ids: geoTargetIds, warnings };
}

module.exports = { planMutations, createCampaignPaused, resolveGeo, stripMatch };
