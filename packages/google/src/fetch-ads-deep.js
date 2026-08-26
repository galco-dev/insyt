// Google Ads deep fetcher — produces the ctx.adsDeep contract documented in
// packages/rules/src/layer6-deep.js from REAL segment data, so every rule
// that used to run on modelled distributions now runs on measured ones
// (engine-spec §3.2). Rule logic does not change; this adapter does.
//
// Also produces two blocks the rules do not read but the platform does:
//   daily  [{ date, cost_usd, conversions, conversion_value_usd }]  (90d)
//          → spend_daily snapshots → pacing + the consumer spend card (§6.3/6.4)
//   assets carry Google's performance_label → asset_perf_snapshots (§11.3)
//
// Every block is independent: a block whose query fails is returned as null
// (the rule guards on absence → "not yet examined"), never as a guess.
// Money fields keep the *_usd naming of the rule contract; values are in
// the account's own currency (currency_code is returned alongside).

const { search, gaqlDate, micros } = require('./fetch-ads');

const DOW = { MONDAY: 0, TUESDAY: 1, WEDNESDAY: 2, THURSDAY: 3, FRIDAY: 4, SATURDAY: 5, SUNDAY: 6 };
const DEVICE = { DESKTOP: 'desktop', MOBILE: 'mobile', TABLET: 'tablet' };
const MATCH = { EXACT: 'exact', PHRASE: 'phrase', BROAD: 'broad' };
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pct = (share) => (share == null ? null : Math.round(Number(share) * 1000) / 10);
const r2 = (n) => Math.round(n * 100) / 100;

/** Sum rows into a map keyed by keyFn; each bucket gets cost/conversions. */
function bucket(rows, keyFn, init = () => ({ cost_usd: 0, conversions: 0 })) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, init(r));
    const b = map.get(k); const m = r.metrics || {};
    b.cost_usd += micros(m.costMicros);
    b.conversions += Number(m.conversions || 0);
    if ('clicks' in b) b.clicks += Number(m.clicks || 0);
    if ('conversion_value_usd' in b) b.conversion_value_usd += Number(m.conversionsValue || 0);
  }
  for (const b of map.values()) { b.cost_usd = r2(b.cost_usd); b.conversions = r2(b.conversions); }
  return map;
}

/**
 * fetchAdsDeep({ auth, tenantId, customerId, developerToken, loginCustomerId, now? })
 * -> adsDeep block (see layer6-deep.js) + { daily, currency_code, time_zone, fetched_at, blocks }
 * `blocks` names which datasets arrived (measured) and which failed (with the reason).
 */
async function fetchAdsDeep({ auth, tenantId, customerId, developerToken, loginCustomerId, now = Date.now() }) {
  const ctx = { auth, tenantId, customerId, developerToken, loginCustomerId };
  const d30 = gaqlDate(30, now); const d90 = gaqlDate(90, now); const d180 = gaqlDate(180, now); const today = gaqlDate(0, now);
  const between = (from) => `segments.date BETWEEN '${from}' AND '${today}'`;

  const queries = {
    customer: `SELECT customer.currency_code, customer.time_zone FROM customer`,
    keywords: `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score, ad_group_criterion.criterion_id,
             campaign.id, ad_group.id, ad_group.name,
             metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM keyword_view WHERE ${between(d90)} AND ad_group_criterion.status != 'REMOVED'`,
    hours: `SELECT segments.hour, metrics.cost_micros, metrics.conversions FROM campaign WHERE ${between(d30)}`,
    days: `SELECT segments.day_of_week, metrics.cost_micros, metrics.conversions FROM campaign WHERE ${between(d90)}`,
    devices: `SELECT segments.device, metrics.cost_micros, metrics.conversions FROM campaign WHERE ${between(d90)}`,
    share: `
      SELECT campaign.id, metrics.search_click_share, metrics.search_exact_match_impression_share,
             metrics.search_budget_lost_impression_share, metrics.invalid_click_rate, metrics.cost_micros
      FROM campaign WHERE ${between(d30)} AND campaign.advertising_channel_type = 'SEARCH' AND campaign.status = 'ENABLED'`,
    monthly: `
      SELECT segments.month, campaign.id, metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM campaign WHERE ${between(d180)}`,
    assets: `
      SELECT campaign.id, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.pinned_field,
             ad_group_ad_asset_view.performance_label, asset.text_asset.text, metrics.impressions
      FROM ad_group_ad_asset_view WHERE ${between(d30)}
        AND ad_group_ad_asset_view.field_type IN ('HEADLINE','DESCRIPTION') AND ad_group_ad.status = 'ENABLED'`,
    daily: `
      SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM customer WHERE ${between(d90)}`,
  };

  const blocks = {};
  const results = {};
  await Promise.all(Object.entries(queries).map(async ([name, query]) => {
    try {
      results[name] = await search({ ...ctx, query });
      blocks[name] = { status: 'measured', rows: results[name].length };
    } catch (e) {
      results[name] = null;
      blocks[name] = { status: 'unavailable', reason: (e && (e.code || e.message)) || 'error' };
    }
  }));

  const cust = results.customer && results.customer[0] && results.customer[0].customer;

  // keywords: one row per keyword × date → aggregate per criterion
  let keywords = null;
  if (results.keywords) {
    const map = bucket(results.keywords,
      (r) => `${r.adGroupCriterion.keyword.text}::${r.adGroupCriterion.keyword.matchType}::${r.campaign.id}::${r.adGroup && r.adGroup.name}`,
      (r) => ({
        keyword: r.adGroupCriterion.keyword.text,
        match: MATCH[r.adGroupCriterion.keyword.matchType] || String(r.adGroupCriterion.keyword.matchType || '').toLowerCase(),
        campaign_id: String(r.campaign.id), ad_group: r.adGroup && r.adGroup.name,
        ad_group_id: r.adGroup && r.adGroup.id != null ? String(r.adGroup.id) : null,
        criterion_id: r.adGroupCriterion.criterionId != null ? String(r.adGroupCriterion.criterionId) : null, // ads.pause_keyword target
        cost_usd: 0, clicks: 0, conversions: 0,
        quality_score: r.adGroupCriterion.qualityInfo && r.adGroupCriterion.qualityInfo.qualityScore != null
          ? Number(r.adGroupCriterion.qualityInfo.qualityScore) : null,
      }));
    keywords = [...map.values()];
  }

  let hours = null;
  if (results.hours) {
    const map = bucket(results.hours, (r) => (r.segments && r.segments.hour != null ? Number(r.segments.hour) : null),
      (r) => ({ hour: Number(r.segments.hour), cost_usd: 0, conversions: 0 }));
    hours = [...map.values()].sort((a, b) => a.hour - b.hour);
  }

  let days = null;
  if (results.days) {
    const map = bucket(results.days, (r) => (r.segments && DOW[r.segments.dayOfWeek] != null ? DOW[r.segments.dayOfWeek] : null),
      (r) => ({ dow: DOW[r.segments.dayOfWeek], cost_usd: 0, conversions: 0 }));
    days = [...map.values()].sort((a, b) => a.dow - b.dow);
  }

  let devices = null;
  if (results.devices) {
    const map = bucket(results.devices, (r) => (r.segments && DEVICE[r.segments.device]) || null,
      (r) => ({ device: DEVICE[r.segments.device], cost_usd: 0, conversions: 0 }));
    devices = [...map.values()];
  }

  let share = null;
  if (results.share) {
    // Share metrics are already period-level for a 30-day BETWEEN on the
    // campaign resource (no date segment selected → one row per campaign).
    share = results.share.map((r) => {
      const m = r.metrics || {};
      return {
        campaign_id: String(r.campaign.id),
        click_share_pct: pct(m.searchClickShare),
        exact_match_is_pct: pct(m.searchExactMatchImpressionShare),
        lost_is_budget_pct: pct(m.searchBudgetLostImpressionShare) || 0,
        invalid_click_rate_pct: pct(m.invalidClickRate) || 0,
        spend_30d_usd: r2(micros(m.costMicros)),
      };
    });
  }

  let monthly = null;
  if (results.monthly) {
    const map = bucket(results.monthly, (r) => (r.segments && r.segments.month ? `${r.segments.month}::${r.campaign.id}` : null),
      (r) => ({ month_iso: r.segments.month, month: MONTH[Number(r.segments.month.slice(5, 7)) - 1], campaign_id: String(r.campaign.id), cost_usd: 0, clicks: 0, conversions: 0 }));
    monthly = [...map.values()].sort((a, b) => a.month_iso.localeCompare(b.month_iso));
  }

  let assets = null;
  if (results.assets) {
    const map = new Map();
    for (const r of results.assets) {
      const v = r.adGroupAdAssetView || {};
      const text = r.asset && r.asset.textAsset && r.asset.textAsset.text;
      if (!text) continue;
      const key = `${text}::${v.fieldType}::${r.campaign.id}`;
      if (!map.has(key)) {
        map.set(key, {
          text, type: v.fieldType === 'HEADLINE' ? 'headline' : 'description', campaign_id: String(r.campaign.id),
          impressions_30d: 0, pinned: !!v.pinnedField && v.pinnedField !== 'UNSPECIFIED' && v.pinnedField !== 'UNKNOWN',
          performance_label: v.performanceLabel || null,
        });
      }
      map.get(key).impressions_30d += Number((r.metrics && r.metrics.impressions) || 0);
    }
    assets = [...map.values()];
  }

  let daily = null;
  if (results.daily) {
    const map = bucket(results.daily, (r) => (r.segments && r.segments.date) || null,
      (r) => ({ date: r.segments.date, cost_usd: 0, conversions: 0, conversion_value_usd: 0 }));
    daily = [...map.values()].map((d) => ({ ...d, conversion_value_usd: r2(d.conversion_value_usd) })).sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    keywords, hours, days, devices, share, monthly, assets, daily,
    currency_code: cust ? cust.currencyCode : null,
    time_zone: cust ? cust.timeZone : null,
    fetched_at: new Date(now).toISOString(),
    blocks,
  };
}

module.exports = { fetchAdsDeep, bucket };
