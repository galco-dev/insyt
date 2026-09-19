// Railway `web` service bootstrap - wires createApp to the real stores.
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY (deploy/README.md).

require('../../../packages/shared/src/sentry').init({ service: 'web' });

const { createClient } = require('../../../packages/db/src/postgrest');
const { webStore, opsStore, dashStore, agencyStore, billingStore, authStore } = require('../../../packages/db/src/stores');
const { discoveryCrawl } = require('../../../packages/crawler/src/crawl');
const { handleWebhook } = require('../../../packages/billing/src/webhooks');
const { createApp } = require('./server');
const { createConnected } = require('./connected');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const supa = webStore(db);

// Adapt the async Supabase-backed store to the server's store contract.
// (In-memory maps in tests; PostgREST rows here. The crawl cache keeps the
// polling endpoint cheap between PostgREST round-trips.)
const crawlCache = new Map();
const store = {
  createCrawl(row) {
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    crawlCache.set(tempId, row);
    supa.createCrawlRow(row).then((id) => { crawlCache.set(tempId, { ...row, db_id: id }); }).catch(() => {});
    return tempId;
  },
  getCrawl(id) { return crawlCache.get(id); },
  patchCrawl(id, patch) {
    const row = crawlCache.get(id);
    if (!row) return;
    Object.assign(row, patch);
    if (row.db_id) {
      supa.patchCrawlRow(row.db_id, {
        status: patch.status, tags_found: patch.result ? patch.result.tags_found : undefined,
        cms_fingerprint: patch.result ? patch.result.cms_fingerprint : undefined,
        booking_provider: patch.result ? patch.result.booking_provider : undefined,
        pages_crawled: patch.result ? patch.result.pages_crawled : undefined,
      }).catch(() => {});
    }
  },
  crawlCountForDomain(domain, sinceMs) {
    // Local window guard; the durable §5 limit rides on the crawls table and
    // is enforced again at the worker. Failed checks never count.
    return [...crawlCache.values()].filter((c) => c.domain === domain && c.created_at >= sinceMs && c.status !== 'failed').length;
  },
  recentCrawlForDomain(domain, sinceMs) {
    const hits = [...crawlCache.entries()].filter(([, c]) => c.domain === domain && c.created_at >= sinceMs && c.status !== 'failed');
    if (!hits.length) return null;
    const [id, c] = hits.sort((a, b) => b[1].created_at - a[1].created_at)[0];
    return { id, status: c.status, created_at: c.created_at };
  },
  getReportHtml: (id) => supa.getReportHtml(id),
  magicLinks: supa.magicLinks,
};

// BullMQ producer for /ops "run now".
let queue = { enqueue: async () => {} };
if (process.env.REDIS_URL) {
  // eslint-disable-next-line global-require
  const { Queue } = require('bullmq');
  const queues = new Map();
  queue = {
    enqueue: async (name, run) => {
      if (!queues.has(name)) queues.set(name, new Queue(name, { connection: { url: process.env.REDIS_URL } }));
      await queues.get(name).add('run', { run }, { jobId: `run:${run.tenant_id}:${run.id}` });
    },
  };
}

// Google data-scope OAuth deps (§6) - active once the GCP client exists.
const baseUrl = process.env.APP_BASE_URL || 'https://app.tryinsyt.com';
// Railway carries the OAuth client as GOOGLE_OAUTH_CLIENT_ID/SECRET; the
// older GOOGLE_CLIENT_ID/SECRET names still work.
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const googleAuth = (googleClientId && googleClientSecret) ? {
  db,
  config: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: process.env.OAUTH_REDIRECT_URL || `${baseUrl}/auth/google/callback`,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '3315824995',
  },
} : null;

// Campaign executor deps (engine-spec §5): live Ads transports per tenant
// and the Fable copy path. Both optional - without them drafts stay
// provisional and copy comes from the deterministic builder.
const { createGoogleAuth } = require('../../../packages/google/src/client');
const { fetchAds, fetchBillingStatus } = require('../../../packages/google/src/fetch-ads');
const { createTransports } = require('../../../packages/tools/src/transports');
const { MODEL_ID } = require('../../../packages/shared/src/model-config');
const qd = (s) => encodeURIComponent(s);
let draftGoogle = null;
if (googleAuth && googleAuth.config.developerToken) {
  const auth = createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret });
  const { developerToken, loginCustomerId } = googleAuth.config;
  const adsAsset = async (tenantId) => db.select('assets', `tenant_id=eq.${qd(tenantId)}&kind=eq.ads_account&linked=eq.true&select=external_id,metadata&limit=1`, { single: true });
  draftGoogle = {
    // Customer's own account acts as itself; the MCC header only for accounts under it.
    // A string under_mcc names the manager account to log in through (fix plan move 17); true means our own.
    fetchAds: async (tenantId) => { const a = await adsAsset(tenantId); if (!a) throw new Error('no linked Ads asset'); return fetchAds({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: a.metadata && a.metadata.under_mcc ? (typeof a.metadata.under_mcc === 'string' ? a.metadata.under_mcc : loginCustomerId) : a.external_id }); },
    // Ad money (launch journey): null when the read fails, never a gate on its own.
    billingStatus: async (tenantId) => { const a = await adsAsset(tenantId); if (!a) return null; return fetchBillingStatus({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: a.metadata && a.metadata.under_mcc ? (typeof a.metadata.under_mcc === 'string' ? a.metadata.under_mcc : loginCustomerId) : a.external_id }); },
    transportsFor: async (tenantId) => { const a = await adsAsset(tenantId); if (!a) throw new Error('no linked Ads asset'); return createTransports({ auth, tenantId, developerToken, loginCustomerId: a.metadata && a.metadata.under_mcc ? (typeof a.metadata.under_mcc === 'string' ? a.metadata.under_mcc : loginCustomerId) : a.external_id, customerId: a.external_id }); },
  };
}
const draftModel = process.env.ANTHROPIC_API_KEY ? {
  generate: async ({ system, prompt, tenantId = null }) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      // Thinking is always on for this model family and its tokens count against
      // max_tokens, so the cap leaves room; low effort keeps a chat reply quick.
      body: JSON.stringify({ model: MODEL_ID, max_tokens: 4000, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: prompt }] }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`anthropic: ${res.status}`);
    if (body.stop_reason === 'refusal') throw new Error('anthropic: refusal');
    const usage = body.usage || {};
    if (tenantId) {
      const { createTelemetry, modelCost } = require('../../../packages/shared/src/telemetry');
      const { MODEL_PRICE_IN_PER_MTOK, MODEL_PRICE_OUT_PER_MTOK } = require('../../../packages/shared/src/model-config');
      createTelemetry({ db }).modelUsage({ tenantId, inputTokens: Number(usage.input_tokens || 0), outputTokens: Number(usage.output_tokens || 0), costUsd: modelCost({ inputTokens: Number(usage.input_tokens || 0), outputTokens: Number(usage.output_tokens || 0), priceIn: MODEL_PRICE_IN_PER_MTOK, priceOut: MODEL_PRICE_OUT_PER_MTOK }) });
    }
    // The first block is thinking on current models; the reply is the first text block.
    const text = (body.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new Error('anthropic: empty reply');
    return text;
  },
} : null;
// §5.1: Insyt creates the missing GA4 property / GTM container on the write grant.
const provisioner = googleAuth ? {
  provision: async (tenantId) => {
    const { provisionMissing } = require('../../../packages/google/src/provision');
    const auth = createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret });
    const t = await db.select('tenants', `id=eq.${qd(tenantId)}&select=business_name,website_url`, { single: true });
    if (!t || !t.website_url) throw new Error('tenant has no website on file');
    return provisionMissing({ auth, db, tenantId, websiteUrl: t.website_url, displayName: t.business_name || t.website_url });
  },
} : null;
// Launch journey: a Google Ads account for a business that has none, created
// under our manager account with Insyt's own credentials (never the customer's).
// The manager credentials are Insyt's own Google login (the user that
// administers the manager account), which signs in to the app like anyone
// else: its refresh token already lives in google_connections. An env
// override (GOOGLE_ADS_MANAGER_REFRESH_TOKEN) wins when set.
const MANAGER_EMAIL = (process.env.GOOGLE_ADS_MANAGER_EMAIL || 'hello@tryinsyt.com').toLowerCase();
async function managerRefreshToken() {
  if (process.env.GOOGLE_ADS_MANAGER_REFRESH_TOKEN) return process.env.GOOGLE_ADS_MANAGER_REFRESH_TOKEN;
  const users = await db.select('users', `email=ilike.${qd(MANAGER_EMAIL)}&select=id&order=last_seen_at.desc.nullslast&limit=5`).catch(() => []);
  for (const u of users || []) {
    const c = await db.select('google_connections', `user_id=eq.${qd(u.id)}&status=eq.valid&select=refresh_token,granted_scopes&limit=1`, { single: true }).catch(() => null);
    if (c && c.refresh_token && (!Array.isArray(c.granted_scopes) || c.granted_scopes.some((s) => /adwords/.test(s)))) return c.refresh_token;
  }
  return null;
}
const adsAccountCreator = googleAuth && googleAuth.config.developerToken ? {
  available: async () => !!(await managerRefreshToken().catch(() => null)),
  create: async ({ descriptiveName, currency, timeZone, ownerEmail }) => {
    const { createAdsAccount } = require('../../../packages/google/src/create-account');
    const token = await managerRefreshToken();
    if (!token) throw new Error('manager credentials not configured');
    return createAdsAccount({
      clientId: googleClientId, clientSecret: googleClientSecret, managerRefreshToken: token,
      developerToken: googleAuth.config.developerToken, managerId: googleAuth.config.loginCustomerId, descriptiveName, currency, timeZone, ownerEmail,
    });
  },
} : null;
// §7 assistant: read-only tools + interpreter + chat over the same model client.
const { createReadTools } = require('../../../packages/assistant/src/tools');
const { createAssistant } = require('../../../packages/assistant/src/chat');
const dashForTools = dashStore(db, {});
const assistant = draftModel ? createAssistant({
  db, generate: draftModel.generate, modelId: MODEL_ID,
  tools: createReadTools({ db, dashStore: dashForTools }), dashStore: dashForTools,
  // Stripe metered item lands when billing keys are configured (§10.5); until
  // then consent is recorded + ledgered and nothing is charged.
  usage: process.env.STRIPE_SECRET_KEY ? null : null,
}) : null;
const draftDeps = { google: draftGoogle, model: draftModel, modelId: MODEL_ID, provisioner, assistant, adsAccountCreator };

// Connected data screen: reads through the same Google client the worker
// uses; Ads actions become approved change rows the worker applies.
const connected = createConnected({
  db,
  auth: googleAuth ? createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret }) : null,
  developerToken: googleAuth ? googleAuth.config.developerToken : null,
  mccId: googleAuth ? googleAuth.config.loginCustomerId : '3315824995',
});

// Stripe checkout deps (§10) - active once STRIPE_SECRET_KEY exists.
let checkout = null;
if (process.env.STRIPE_SECRET_KEY) {
  const { createStripeCheckout } = require('../../../packages/billing/src/checkout');
  const stripe = createStripeCheckout({ secretKey: process.env.STRIPE_SECRET_KEY });
  const qe = (s) => encodeURIComponent(s);
  const ownerEmail = async (tenantId) => {
    const u = await db.select('users', `tenant_id=eq.${qe(tenantId)}&select=email&limit=1`, { single: true });
    return u && u.email;
  };
  checkout = {
    pause: (subscriptionId, until) => stripe.pauseSubscription(subscriptionId, until),
    resume: (subscriptionId) => stripe.resumeSubscription(subscriptionId),
    // The $20 unlock returns to the report the customer was reading.
    audit: async ({ tenantId, kind, next }) => stripe.auditCheckout({
      tenantId, kind, customerEmail: await ownerEmail(tenantId),
      successUrl: `${baseUrl}${next || '/app'}${(next || '/app').includes('?') ? '&' : '?'}paid=1`, cancelUrl: `${baseUrl}${next || '/app'}`,
    }),
    // The plan checkout (gated-platform spec §5): saved card first when the
    // $20 created a customer, the audit fee credited once as a coupon, and the
    // tapped change in metadata so the webhook approves it (spec §6).
    subscribe: async ({ tenantId, tier, cadence, next = '/app/approvals', changeId = null }) => {
      const [t, payment, prior] = await Promise.all([
        db.select('tenants', `id=eq.${qe(tenantId)}&select=size_band`, { single: true }),
        db.select('payments', `tenant_id=eq.${qe(tenantId)}&kind=in.(audit_unlock,large_audit,setup_bundle)&select=amount_usd,stripe_customer_id,credited_to_subscription&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
        db.select('subscriptions', `tenant_id=eq.${qe(tenantId)}&select=stripe_customer_id&limit=1`, { single: true }).catch(() => null),
      ]);
      const customerId = (prior && prior.stripe_customer_id) || (payment && payment.stripe_customer_id) || null;
      const creditUsd = payment && !prior && !payment.credited_to_subscription ? Math.min(Number(payment.amount_usd || 0), 20) : 0;
      const join = next.includes('?') ? '&' : '?';
      return stripe.subscriptionCheckout({
        tenantId, tier, band: (t && t.size_band) || '4k', cadence,
        customerEmail: await ownerEmail(tenantId), customerId, creditUsd, changeId,
        successUrl: `${baseUrl}${next}${join}subscribed=1${changeId ? `&pa=${qe(changeId)}` : ''}`,
        cancelUrl: `${baseUrl}${next}`,
      });
    },
    portal: async ({ tenantId }) => {
      const [sub, payment] = await Promise.all([
        db.select('subscriptions', `tenant_id=eq.${qe(tenantId)}&select=stripe_customer_id&limit=1`, { single: true }),
        db.select('payments', `tenant_id=eq.${qe(tenantId)}&select=stripe_customer_id&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
      ]);
      const customerId = (sub && sub.stripe_customer_id) || (payment && payment.stripe_customer_id);
      if (!customerId) throw new Error('no billing account yet');
      return stripe.portalSession({ customerId, returnUrl: `${baseUrl}/app/settings` });
    },
  };
}

// Look again for accounts (fix plan move 10): on demand from Settings and
// after a website change, over the tenant's own connection.
let rediscover = null;
if (googleAuth) {
  const { rediscoverTenant } = require('../../../packages/google/src/discovery-store');
  const rdAuth = createGoogleAuth({ db, clientId: googleClientId, clientSecret: googleClientSecret });
  rediscover = (tenantId) => rediscoverTenant({ db, auth: rdAuth, developerToken: googleAuth.config.developerToken, loginCustomerId: googleAuth.config.loginCustomerId, tenantId });
}

const app = createApp({
  rediscover,
  store,
  crawler: { discoveryCrawl },
  opsStore: opsStore(db),
  dashStore: dashStore(db, draftDeps),
  agencyStore: agencyStore(db, draftDeps),
  queue,
  opsToken: process.env.OPS_TOKEN || null,
  sessionSecret: required('SESSION_SECRET'),
  billing: process.env.STRIPE_WEBHOOK_SECRET
    ? { handleWebhook, store: billingStore(db), webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
    : null,
  authBridge: {
    // Verify a Supabase access token by asking Supabase who it belongs to.
    verifySupabaseToken: async (token) => {
      const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const u = await res.json();
      const google = (u.identities || []).find((i) => i.provider === 'google');
      if (!google) return null;
      return { sub: google.id, email: u.email, name: u.user_metadata && u.user_metadata.full_name };
    },
    findOrCreateTenantByGoogle: (identity) => authStore(db).findOrCreateTenantByGoogle(identity),
  },
  googleAuth,
  checkout,
  connected,
  clientDir: require('path').join(__dirname, '../public/app'),
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`web listening on :${port}`));
