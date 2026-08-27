// Railway `worker` service bootstrap — wires the §8 pipeline to real I/O.
// With GOOGLE_CLIENT_ID/SECRET present the REAL Google fetchers run (asset
// ids resolved from the tenant's linked assets rows); without them the fetch
// stages throw "not configured" and runs complete honestly degraded.
// The apply loop (§4) drains approved changes every minute when creds exist.

require('../../../packages/shared/src/sentry').init({ service: 'worker' });

const { createClient } = require('../../../packages/db/src/postgrest');
const { workerStore } = require('../../../packages/db/src/stores');
const { discoveryCrawl } = require('../../../packages/crawler/src/crawl');
const { createGoogleAuth } = require('../../../packages/google/src/client');
const { fetchGtmSnapshot } = require('../../../packages/google/src/fetch-gtm');
const { fetchGa4Config, fetchGa4Data } = require('../../../packages/google/src/fetch-ga4');
const { fetchAds, fetchWindow } = require('../../../packages/google/src/fetch-ads');
const { fetchAdsDeep } = require('../../../packages/google/src/fetch-ads-deep');
const { createTelemetry, modelCost } = require('../../../packages/shared/src/telemetry');
const { MODEL_ID, MODEL_PRICE_IN_PER_MTOK, MODEL_PRICE_OUT_PER_MTOK } = require('../../../packages/shared/src/model-config');
const { createTransports } = require('../../../packages/tools/src/transports');
const { scanAndApply } = require('./apply');
const { start } = require('./service');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const q = (s) => encodeURIComponent(s);
// Railway carries the OAuth client as GOOGLE_OAUTH_CLIENT_ID/SECRET; the
// older GOOGLE_CLIENT_ID/SECRET names still work.
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const googleConfigured = !!(googleClientId && googleClientSecret);
const auth = googleConfigured
  ? createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret })
  : null;
const telemetry = createTelemetry({ db, log: (m) => console.warn(m) });
const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
const mccId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3315824995';

async function linkedAsset(tenantId, kind) {
  return db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.${kind}&linked=eq.true&select=external_id,metadata&limit=1`, { single: true });
}

// login-customer-id: Google wants the id the user is acting AS. A customer's
// own account (their OAuth token, their account) must use its own id; our MCC
// header only applies to accounts that sit under the MCC (Journey B creates,
// agency imports). Sending the MCC for an unrelated account = USER_PERMISSION_DENIED.
function loginFor(a) {
  return a && a.metadata && a.metadata.under_mcc ? mccId : (a ? a.external_id : mccId);
}

const notConfigured = (what) => async () => { throw new Error(`${what} not configured yet (needs Google OAuth client)`); };

const google = googleConfigured ? {
  fetchGtmSnapshot: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'gtm_container');
    if (!a) throw new Error('no linked GTM asset');
    return fetchGtmSnapshot({
      auth, tenantId, containerPublicId: a.external_id,
      accountId: a.metadata && a.metadata.account_id, containerId: a.metadata && a.metadata.container_id,
    });
  },
  fetchGa4Config: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ga4_property');
    if (!a) throw new Error('no linked GA4 asset');
    return fetchGa4Config({ auth, tenantId, propertyId: a.external_id });
  },
  fetchGa4Data: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ga4_property');
    if (!a) throw new Error('no linked GA4 asset');
    return fetchGa4Data({ auth, tenantId, propertyId: a.external_id });
  },
  fetchAds: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ads_account');
    if (!a) throw new Error('no linked Ads asset');
    if (!developerToken) throw new Error('ads reads not configured (developer token pending)');
    return fetchAds({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: loginFor(a) });
  },
  // Watch-window measurement for watch_close (§4.4).
  fetchWindow: async (tenantId, { since, campaignIds, terms }) => {
    const a = await linkedAsset(tenantId, 'ads_account');
    if (!a) throw new Error('no linked Ads asset');
    return fetchWindow({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: loginFor(a), since, campaignIds, terms });
  },
  // Deep blocks (hours, days, devices, share, keywords, monthly, assets,
  // daily) — the modelled→measured flip. Failure degrades per block.
  fetchAdsDeep: async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ads_account');
    if (!a) throw new Error('no linked Ads asset');
    if (!developerToken) throw new Error('ads reads not configured (developer token pending)');
    return fetchAdsDeep({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: loginFor(a) });
  },
} : {
  fetchGtmSnapshot: notConfigured('gtm fetch'),
  fetchGa4Config: notConfigured('ga4 config fetch'),
  fetchGa4Data: notConfigured('ga4 data fetch'),
  fetchAds: notConfigured('ads fetch'),
};

const crawler = {
  verificationCrawl: async (url) => {
    if (!url) throw new Error('tenant has no website_url');
    const result = await discoveryCrawl(url);
    return {
      pages: (result.pages || []).map((p, i) => ({
        url: p.url, ok: p.ok, is_homepage: i === 0,
        gtm_containers_seen: result.tags_found.gtm_containers || [],
        collect_measurement_ids: result.tags_found.ga4_ids || [],
      })),
    };
  },
};

// Model policy (engine-spec §1): Fable only, model ID is config, every call
// metered per tenant (§9.9) and attributed. Narration is deterministic-first;
// a model outage degrades to payload framing (stages.js), never blocks a run.
const model = {
  generate: async ({ system, prompt, tenantId = null, runId = null }) => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('narration not configured (no ANTHROPIC_API_KEY)');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(45_000), // one slow call must never eat the whole stage budget
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`anthropic: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    const usage = body.usage || {};
    const cached = Number(usage.cache_read_input_tokens || 0);
    const inputTokens = Number(usage.input_tokens || 0) + cached + Number(usage.cache_creation_input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    const costUsd = modelCost({ inputTokens, outputTokens, cachedTokens: cached, priceIn: MODEL_PRICE_IN_PER_MTOK, priceOut: MODEL_PRICE_OUT_PER_MTOK });
    if (tenantId) {
      // Per-call row (existing token_metering) + monthly aggregate (§9.9).
      db.insert('token_metering', [{ tenant_id: tenantId, run_id: runId, model: body.model || MODEL_ID, input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cached, cost_usd: costUsd }], { returning: false }).catch(() => {});
      telemetry.modelUsage({ tenantId, inputTokens, outputTokens, costUsd });
    }
    // Fable can return thinking blocks before the text; take every text block.
    const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error(`anthropic: no text block in reply (${(body.content || []).map((b) => b.type).join(',') || 'empty'})`);
    return text;
  },
};

start({
  clients: { google, crawler, model },
  store: workerStore(db),
  redisUrl: required('REDIS_URL'),
}).then(() => console.log('worker consuming queues')).catch((e) => { console.error(e); process.exit(1); });

// §4 apply loop: approved changes → executor → transports, per minute.
if (googleConfigured) {
  const makeApi = async (tenantId) => {
    const a = await linkedAsset(tenantId, 'ads_account');
    return createTransports({ auth, tenantId, developerToken, loginCustomerId: loginFor(a), customerId: a ? a.external_id : null });
  };
  const makeCtx = async (tenantId) => {
    // Guardrail context from live data where reachable; conservative otherwise.
    let ads = null;
    try { ads = await google.fetchAds(tenantId); } catch { /* ads-less ctx below */ }
    const campaigns = new Map((ads ? ads.campaigns : []).map((c) => [String(c.id), c]));
    const [approvals, journey, keyEventsCfg] = await Promise.all([
      db.select('approvals', `tenant_id=eq.${q(tenantId)}&select=scope,target_id`),
      db.select('journey_state', `tenant_id=eq.${q(tenantId)}&select=gates&limit=1`, { single: true }),
      google.fetchGa4Config(tenantId).catch(() => null),
    ]);
    const applied = await db.select('changes',
      `tenant_id=eq.${q(tenantId)}&status=in.(applied,reverted)&tool_id=in.(ads.pause_campaign,ads.pause_keyword,ads.add_negative_keywords)&select=tool_id,params,after`);
    const pausedByUs = new Set(applied.filter((c) => c.tool_id === 'ads.pause_campaign').map((c) => c.params && String(c.params.campaign_id)).filter(Boolean));
    const pausedKeywordsByUs = new Set(applied.filter((c) => c.tool_id === 'ads.pause_keyword').map((c) => c.params && `${c.params.ad_group_id}~${c.params.criterion_id}`));
    const negativesByUs = new Set(applied.filter((c) => c.tool_id === 'ads.add_negative_keywords').flatMap((c) => (c.after && c.after.resource_names) || []));
    return {
      account: {
        daily_budget_total_usd: (ads ? ads.campaigns : []).reduce((s, c) => s + (c.budget_daily_usd || 0), 0) || 1,
        weekly_budget_delta_pct: 0, // per-week accounting joins the ledger later
        platform_min_daily_usd: 1,
      },
      campaign: (id) => campaigns.get(String(id)),
      convertingTerms: new Set((ads ? ads.search_terms : []).filter((t) => t.conversions_90d > 0).map((t) => t.term)),
      pausedByUs, pausedKeywordsByUs, negativesByUs,
      primaryActionCount: ads ? ads.conversion_actions.filter((a) => a.primary).length : 0,
      keyEventCount: keyEventsCfg ? keyEventsCfg.key_events.length : 0,
      linkedAdsCustomerIds: ads ? [ads.customer_id] : [],
      approvals,
      gates: (journey && journey.gates) || {},
    };
  };
  setInterval(() => {
    scanAndApply({ db, makeApi, makeCtx })
      .then((r) => { if (r.tenants) console.log(`apply loop: ${r.applied} applied, ${r.failed} failed across ${r.tenants} tenant(s)`); })
      .catch((e) => console.error('apply loop failed:', e.message));
  }, 60_000);
  console.log('apply loop active (1-minute tick)');
} else {
  console.log('apply loop idle: Google OAuth client not configured');
}

// Narration repair — findings that shipped with empty copy (model outage,
// unparseable reply) get their title/explanation written on the next tick.
// Same grounded narrator, same register rules; 40 findings per 10 minutes.
if (process.env.ANTHROPIC_API_KEY) {
  const { narrateFinding } = require('../../../packages/report/src/narration');
  const repairNarration = async () => {
    const rows = await db.select('findings', "explanation=eq.&status=eq.open&select=id,run_id,tenant_id,rule_id,layer,severity,title,money_impact_monthly_usd,campaign_name,payload&order=created_at.desc&limit=40");
    let fixed = 0;
    for (const f of rows) {
      try {
        const generate = (args) => model.generate({ ...args, tenantId: f.tenant_id, runId: f.run_id });
        const { title, explanation } = await narrateFinding({ ...f, title: undefined }, generate);
        if (title && explanation) { await db.update('findings', `id=eq.${q(f.id)}`, { title, explanation }); fixed += 1; }
      } catch (e) {
        console.warn(`narration repair skipped ${f.rule_id} (${f.id}): ${e.message}`);
      }
    }
    if (rows.length) console.log(`narration repair: ${fixed}/${rows.length} rewritten`);
    // Re-render the affected reports from their stored envelope so the
    // report page and the email copy carry the repaired titles too.
    if (fixed) {
      const { renderReport } = require('../../../packages/report/src/render');
      for (const runId of new Set(rows.map((r) => r.run_id))) {
        try {
          const run = await db.select('runs', `id=eq.${q(runId)}&select=checkpoint`, { single: true });
          const env = run && run.checkpoint && run.checkpoint.ctx && run.checkpoint.ctx.envelope;
          if (!env) continue;
          const fresh = await db.select('findings', `run_id=eq.${q(runId)}&select=id,title,explanation`);
          const byId = new Map(fresh.map((f) => [f.id, f]));
          env.findings = env.findings.map((f) => { const k = f.finding_id || f.id; return byId.has(k) ? { ...f, title: byId.get(k).title, explanation: byId.get(k).explanation } : f; });
          const health = run.checkpoint.ctx.health_score ?? null;
          await db.update('reports', `run_id=eq.${q(runId)}`, {
            html_web: renderReport(env, { unlocked: false, healthScore: health, mode: 'web' }),
            html_email: renderReport(env, { unlocked: false, healthScore: health, mode: 'email' }),
            findings_snapshot: env.findings,
          });
        } catch (e) { console.warn(`report re-render skipped for run ${runId}: ${e.message}`); }
      }
    }
  };
  setInterval(() => repairNarration().catch((e) => console.error('narration repair failed:', e.message)), 10 * 60_000);
  setTimeout(() => repairNarration().catch((e) => console.error('narration repair failed:', e.message)), 90_000);
  console.log('narration repair active (10-minute tick)');
}
