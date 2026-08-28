// Google Ads fetcher — produces the Layer 4 input contract documented in
// packages/rules/src/layer4-ads.js, via the Ads REST API (searchStream GAQL).
// Requires the developer token (env) and login-customer-id (our MCC) headers.
// Basic Access is granted (manager 331-582-4995); the pipeline still
// degrades honestly on PERMISSION_DENIED for unlinked accounts.
// The deep block (hours, days, devices, share, keywords, monthly, assets,
// daily) lives in fetch-ads-deep.js and is attached by the worker stage.

// API version is config, not code: Google sunsets versions roughly a year
// after release, so a bump is an env change (GOOGLE_ADS_API_VERSION).
const VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v24';
const MAX_PAGES = 10; // 10k rows per page — enough for any SMB account

function gaqlDate(daysAgo, now = Date.now()) {
  return new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** GAQL search with paging. Returns the flat results array. */
async function search({ auth, tenantId, customerId, developerToken, loginCustomerId, query }) {
  const url = `https://googleads.googleapis.com/${VERSION}/customers/${String(customerId).replace(/-/g, '')}/googleAds:search`;
  const headers = {
    'developer-token': developerToken,
    ...(loginCustomerId ? { 'login-customer-id': String(loginCustomerId).replace(/-/g, '') } : {}),
  };
  const out = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await auth.api(tenantId, url, {
      method: 'POST', headers,
      body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
    });
    out.push(...(body.results || []));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

const micros = (v) => Number(v || 0) / 1_000_000;

/** Layer 4 contract. */
// GA4-imported action names read "<property> (web) <event_name>"; older
// imports read "<event_name> (GA4)". The event is what identifies a double count.
function ga4EventFromActionName(name) {
  const n = String(name || '').trim();
  const afterParen = n.includes(')') ? n.slice(n.lastIndexOf(')') + 1).trim() : '';
  const raw = afterParen || n.split('(')[0].trim();
  return raw.toLowerCase().replace(/\s+/g, '_');
}

async function fetchAds({ auth, tenantId, customerId, developerToken, loginCustomerId, ga4KeyEvents30d = null }) {
  const ctx = { auth, tenantId, customerId, developerToken, loginCustomerId };
  const d30 = gaqlDate(30); const d90 = gaqlDate(90); const today = gaqlDate(0);

  const [campaigns, terms, actions, spend90, disapproved, convo30, customer] = await Promise.all([
    search({ ...ctx, query: `
      SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
             campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
             campaign_budget.amount_micros, campaign_budget.resource_name, metrics.cost_micros, metrics.conversions,
             metrics.search_budget_lost_impression_share
      FROM campaign WHERE segments.date BETWEEN '${d30}' AND '${today}'` }),
    search({ ...ctx, query: `
      SELECT search_term_view.search_term, campaign.id, metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM search_term_view WHERE segments.date BETWEEN '${d90}' AND '${today}' AND campaign.status = 'ENABLED'` }),
    search({ ...ctx, query: `
      SELECT conversion_action.id, conversion_action.name, conversion_action.primary_for_goal,
             conversion_action.type, conversion_action.status, conversion_action.origin, conversion_action.category
      FROM conversion_action WHERE conversion_action.status = 'ENABLED'` }),
    search({ ...ctx, query: `
      SELECT metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${d90}' AND '${today}'` }),
    search({ ...ctx, query: `
      SELECT ad_group_ad.ad.id, ad_group.name, campaign.id, ad_group_ad.policy_summary.approval_status
      FROM ad_group_ad WHERE ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED','AREA_OF_INTEREST_ONLY')
        AND ad_group_ad.status = 'ENABLED'` }),
    search({ ...ctx, query: `
      SELECT segments.conversion_action, segments.conversion_action_name, metrics.conversions
      FROM customer WHERE segments.date BETWEEN '${d30}' AND '${today}' AND metrics.conversions > 0` }),
    search({ ...ctx, query: 'SELECT customer.currency_code FROM customer' }),
  ]);

  // Aggregate campaign rows (one per date segment when segmented — here totals).
  const campMap = new Map();
  for (const r of campaigns) {
    const c = r.campaign; const m = r.metrics || {};
    const id = String(c.id);
    if (!campMap.has(id)) {
      campMap.set(id, {
        id, name: c.name, status: (c.status || '').toLowerCase() === 'enabled' ? 'enabled' : 'paused',
        bidding: {
          strategy: ({ TARGET_CPA: 'tcpa', TARGET_ROAS: 'troas', MAXIMIZE_CONVERSIONS: 'max_conversions', MAXIMIZE_CONVERSION_VALUE: 'max_conversion_value' })[c.biddingStrategyType] || (c.biddingStrategyType || '').toLowerCase(),
          target: c.targetCpa ? micros(c.targetCpa.targetCpaMicros) : (c.targetRoas ? Number(c.targetRoas.targetRoas) : undefined),
        },
        budget_daily_usd: r.campaignBudget ? micros(r.campaignBudget.amountMicros) : 0,
        budget_resource: r.campaignBudget ? r.campaignBudget.resourceName || null : null, // ads.adjust_budget target
        budget_lost_is_pct: 0, spend_30d_usd: 0, conversions_30d: 0,
      });
    }
    const agg = campMap.get(id);
    agg.spend_30d_usd += micros(m.costMicros);
    agg.conversions_30d += Number(m.conversions || 0);
    agg.budget_lost_is_pct = Math.max(agg.budget_lost_is_pct, Math.round(Number(m.searchBudgetLostImpressionShare || 0) * 100));
  }

  const termMap = new Map();
  for (const r of terms) {
    const key = `${r.searchTermView.searchTerm}::${r.campaign.id}`;
    if (!termMap.has(key)) termMap.set(key, { term: r.searchTermView.searchTerm, campaign_id: String(r.campaign.id), spend_90d_usd: 0, clicks_90d: 0, conversions_90d: 0 });
    const t = termMap.get(key);
    t.spend_90d_usd += micros(r.metrics && r.metrics.costMicros);
    t.clicks_90d += Number((r.metrics && r.metrics.clicks) || 0);
    t.conversions_90d += Number((r.metrics && r.metrics.conversions) || 0);
  }

  // Per-action 30d conversion counts joined onto the action list.
  const countByActionName = new Map();
  for (const r of convo30) {
    const name = r.segments && r.segments.conversionActionName;
    countByActionName.set(name, (countByActionName.get(name) || 0) + Number(r.metrics.conversions || 0));
  }

  const conversionActions = actions.map((r) => {
    const a = r.conversionAction;
    const count = countByActionName.get(a.name) || 0;
    return {
      id: String(a.id), name: a.name,
      primary: a.primaryForGoal !== false,
      count_30d: count,
      last_conversion_at: count > 0 ? new Date().toISOString() : null, // per-day last-seen needs a segmented query; day-window census suffices for §3
      source: (a.type || '').includes('GOOGLE_ANALYTICS') ? 'ga4_import' : 'website',
      // Google-hosted actions (Local actions - Directions, Calls from ads…)
      // are system-defined and often legitimately empty.
      system_defined: (a.origin || '') === 'GOOGLE_HOSTED',
      conversion_category: a.category || null,
      ga4_event_name: (a.type || '').includes('GOOGLE_ANALYTICS') ? ga4EventFromActionName(a.name) : null,
    };
  });

  const spend90Usd = spend90.reduce((s, r) => s + micros(r.metrics && r.metrics.costMicros), 0);
  const adsConversions30 = [...campMap.values()].reduce((s, c) => s + c.conversions_30d, 0);

  return {
    customer_id: String(customerId).replace(/-/g, ''),
    // Every money figure in this object is in the ACCOUNT'S OWN currency.
    currency_code: (customer && customer[0] && customer[0].customer && customer[0].customer.currencyCode) || null,
    spend_30d_usd: Math.round([...campMap.values()].reduce((s, c) => s + c.spend_30d_usd, 0)),
    spend_90d_usd: Math.round(spend90Usd),
    conversion_actions: conversionActions,
    campaigns: [...campMap.values()].map((c) => ({ ...c, spend_30d_usd: Math.round(c.spend_30d_usd * 100) / 100 })),
    search_terms: [...termMap.values()],
    disapproved: disapproved.map((r) => ({ ad_id: String(r.adGroupAd.ad.id), ad_group: r.adGroup && r.adGroup.name, campaign_id: String(r.campaign.id), policy: r.adGroupAd.policySummary.approvalStatus })),
    ads_conversions_30d: Math.round(adsConversions30),
    ga4_key_events_30d: ga4KeyEvents30d,
  };
}


/**
 * Watch-window measurement (engine-spec §4.4): account + optional campaign
 * totals since a date, the same-length window before it, and spend on a
 * named set of search terms since the date. One call per watch close.
 */
async function fetchWindow({ auth, tenantId, customerId, developerToken, loginCustomerId, since, campaignIds = [], terms = [], now = Date.now() }) {
  const ctx = { auth, tenantId, customerId, developerToken, loginCustomerId };
  const today = gaqlDate(0, now);
  const sinceMs = Date.parse(`${since.slice(0, 10)}T00:00:00Z`);
  const days = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - sinceMs) / 86_400_000));
  const priorFrom = new Date(sinceMs - days * 86_400_000).toISOString().slice(0, 10);
  const priorTo = new Date(sinceMs - 86_400_000).toISOString().slice(0, 10);
  const sum = (rows) => rows.reduce((a, r) => ({ spend_usd: a.spend_usd + micros(r.metrics && r.metrics.costMicros), conversions: a.conversions + Number((r.metrics && r.metrics.conversions) || 0) }), { spend_usd: 0, conversions: 0 });
  const cidList = campaignIds.map((c) => `'${String(c).replace(/\D/g, '')}'`).join(',');
  const [cur, prior, camp, termRows] = await Promise.all([
    search({ ...ctx, query: `SELECT metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date BETWEEN '${since.slice(0, 10)}' AND '${today}'` }),
    search({ ...ctx, query: `SELECT metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date BETWEEN '${priorFrom}' AND '${priorTo}'` }),
    cidList ? search({ ...ctx, query: `SELECT campaign.id, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${since.slice(0, 10)}' AND '${today}' AND campaign.id IN (${cidList})` }) : Promise.resolve(null),
    terms.length ? search({ ...ctx, query: `SELECT search_term_view.search_term, metrics.cost_micros FROM search_term_view WHERE segments.date BETWEEN '${since.slice(0, 10)}' AND '${today}'` }) : Promise.resolve(null),
  ]);
  const termSet = new Set(terms.map((t) => String(t).toLowerCase()));
  const blocked = termRows ? termRows.filter((r) => termSet.has(String(r.searchTermView.searchTerm).toLowerCase())).reduce((s, r) => s + micros(r.metrics && r.metrics.costMicros), 0) : null;
  const c = sum(cur); const p = sum(prior); const cs = camp ? sum(camp) : null;
  return {
    days, spend_usd: Math.round(c.spend_usd * 100) / 100, conversions: Math.round(c.conversions * 100) / 100,
    prior: { spend_usd: Math.round(p.spend_usd * 100) / 100, conversions: Math.round(p.conversions * 100) / 100 },
    campaign: cs ? { spend_usd: Math.round(cs.spend_usd * 100) / 100, conversions: Math.round(cs.conversions * 100) / 100 } : null,
    blocked_terms_spend_usd: blocked == null ? null : Math.round(blocked * 100) / 100,
  };
}


/**
 * Daily light pass (engine-spec §6.2): not an audit. Eight days of account
 * spend/conversions (yesterday vs the prior 7-day average), enabled ads
 * currently disapproved, and today's spend so far. Three small queries.
 */
async function fetchPulse({ auth, tenantId, customerId, developerToken, loginCustomerId, now = Date.now() }) {
  const ctx = { auth, tenantId, customerId, developerToken, loginCustomerId };
  const today = gaqlDate(0, now); const d8 = gaqlDate(8, now);
  const [daily, disapproved] = await Promise.all([
    search({ ...ctx, query: `SELECT segments.date, metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date BETWEEN '${d8}' AND '${today}'` }),
    search({ ...ctx, query: `SELECT ad_group_ad.ad.id, campaign.id, campaign.name, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED' AND ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED'` }),
  ]);
  const byDate = new Map();
  for (const r of daily) {
    const d = r.segments && r.segments.date; if (!d) continue;
    const b = byDate.get(d) || { date: d, spend_usd: 0, conversions: 0 };
    b.spend_usd += micros(r.metrics && r.metrics.costMicros); b.conversions += Number((r.metrics && r.metrics.conversions) || 0);
    byDate.set(d, b);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, spend_usd: Math.round(d.spend_usd * 100) / 100, conversions: Math.round(d.conversions * 100) / 100 }));
  return {
    days,
    disapproved: disapproved.map((r) => ({ ad_id: String(r.adGroupAd.ad.id), campaign_id: String(r.campaign.id), campaign_name: r.campaign.name })),
    fetched_at: new Date(now).toISOString(),
  };
}

module.exports = { fetchAds, fetchWindow, fetchPulse, search, gaqlDate, micros, VERSION };
