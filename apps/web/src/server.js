// app.tryinsyt.com - Journey A server slice (build-doc §11 screens 1, 3, 4).
// Framework-free node http; React/shadcn dashboard replaces the shell later,
// the routes and store contract stay. All I/O injected for tests.
//
// deps (injected):
//   store: {
//     createCrawl(row) -> id, getCrawl(id), patchCrawl(id, patch),
//     crawlCountForDomain(domain, sinceMs) -> n,
//     getReportHtml(reportId) -> { html_web, unlocked } | null,
//     magicLinks: { findByHash, markUsed, insertLink },   // packages/emails contract
//   }
//   crawler: { discoveryCrawl(url) } - real one on Railway; stub in tests
//   now: () => ms epoch

const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const { findingsStrip } = require('../../../packages/crawler/src/findings-strip');
const { redeemLink, peekLink } = require('../../../packages/emails/src/magic-links');
const { landingPage, progressPage } = require('./pages');
const { handleOps } = require('./ops');
const { issueSession, readSession, cookieFor, clearCookie } = require('./session');
const { handleGoogleAuth } = require('./auth-routes');
const { safeNext } = require('../../../packages/billing/src/access');
const screens = require('./screens');

// The gate (gated-platform spec §2). A write that needs a plan answers 402
// with plan_required so the client opens the Plan sheet; nothing is hidden
// client-side alone. Stores without access() (tests, older adapters) gate
// nothing, so existing contracts keep working.
const PLAN_REQUIRED = { error: 'This needs a plan. Nothing has changed.', plan_required: true, plan_url: '/app/plan' };
async function accessFor(dashStore, tenantId) {
  if (!dashStore || typeof dashStore.access !== 'function') return null;
  try { return await dashStore.access(tenantId); } catch { return null; }
}
async function planActive(dashStore, tenantId) {
  const a = await accessFor(dashStore, tenantId);
  return !a || a.level === 'active';
}

// §5 limits: 1 crawl/domain/hour, 3/day (email-verified: 5 - later).
const LIMITS = { perHour: 1, perDay: 3 };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function html(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function createApp({ store, crawler, now = Date.now, dashStore = null, agencyStore = null, opsStore = null, queue = null, opsToken = null, sessionSecret = 'dev-secret', billing = null, authBridge = null, googleAuth = null, checkout = null, clientDir = null, connected = null, rediscover = null }) {
  // Confirming assets is the moment the first audit starts (§8 signup queue,
  // immediate priority). Idempotent per tenant: a second confirm never queues
  // a second first-audit.
  async function confirmAndStart(tenantId, choices = {}) {
    await dashStore.confirmAssets(tenantId, choices);
    if (!opsStore || !queue) return null;
    try {
      const run = await opsStore.enqueueRun({ tenant_id: tenantId, type: 'signup_audit', status: 'queued', idempotency_key: `signup:${tenantId}` });
      if (run) await queue.enqueue('runs-signup', run);
      return run;
    } catch (e) {
      // Unique idempotency_key = already queued once; anything else is logged, never a dead end for the customer.
      if (!/duplicate|23505|409/.test(String(e && e.message))) console.error(`signup audit enqueue failed for ${tenantId}: ${e && e.message}`);
      return null;
    }
  }

  // React client build (apps/web/client → public/app). When present, GET
  // /app* serves the SPA; the server-rendered screens remain the fallback
  // (tests, and any deploy that predates the client build).
  const clientIndex = clientDir ? nodePath.join(clientDir, 'index.html') : null;
  const hasClient = () => !!clientIndex && fs.existsSync(clientIndex);
  function serveClientFile(res, rel) {
    const file = nodePath.join(clientDir, rel);
    if (!file.startsWith(clientDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[nodePath.extname(file)] || 'application/octet-stream', 'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(fs.readFileSync(file));
    return true;
  }
  async function handleCrawlRequest(res, urlRaw, { force = false, ownSite = false } = {}) {
    let target;
    try { target = new URL(urlRaw.startsWith('http') ? urlRaw : `https://${urlRaw}`); } catch {
      return json(res, 400, { error: 'That does not look like a website address.' });
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(target.hostname)) {
      return json(res, 400, { error: 'That does not look like a website address.' });
    }
    const domain = target.hostname;
    // A check that already finished in the last hour is simply shown again
    // (same id, instant result) - never a refusal. A check still running is
    // joined. Only completed checks count against the per-domain limits;
    // failed ones never lock a visitor out of retrying.
    // Check again after a fix (fix plan move 16): a forced check skips the
    // hour's reuse once the last one is five minutes old; a signed-in owner's
    // own site is never rate-limited.
    if (store.recentCrawlForDomain) {
      const recent = await store.recentCrawlForDomain(domain, now() - 3_600_000);
      const fresh = recent && recent.created_at && now() - Number(recent.created_at) < 5 * 60_000;
      if (recent && recent.status === 'running') return json(res, 202, { id: recent.id, reused: true });
      if (recent && recent.status === 'complete' && (!force || fresh)) return json(res, 202, { id: recent.id, reused: true, checked_at: recent.created_at || null });
    }
    if (!ownSite && !force && (await store.crawlCountForDomain(domain, now() - 3_600_000) >= LIMITS.perHour
      || await store.crawlCountForDomain(domain, now() - 86_400_000) >= LIMITS.perDay)) {
      return json(res, 429, { error: 'This site was checked very recently - try again in a little while.' });
    }
    const id = await store.createCrawl({ url: target.href, domain, status: 'running', created_at: now() });
    // Fire and record; progress endpoint reflects state.
    crawler.discoveryCrawl(target.href)
      .then((result) => store.patchCrawl(id, { status: result.status, result, strip: findingsStrip(result) }))
      .catch((err) => {
        // The visitor sees a plain message; the real reason goes to the service log.
        console.error(`crawl failed for ${domain}: ${String(err.message || err).split('\n')[0].slice(0, 300)}`);
        return store.patchCrawl(id, { status: 'failed', error: String(err.message || err) });
      });
    return json(res, 202, { id });
  }

  // Per-IP ceiling on the public crawl endpoint (the per-domain limits cover
  // one site; this covers one visitor hammering many). In-memory, per process.
  const crawlHits = new Map();
  function crawlAllowed(ip) {
    const t = now();
    const hits = (crawlHits.get(ip) || []).filter((x) => t - x < 3_600_000);
    if (hits.length >= 12) { crawlHits.set(ip, hits); return false; }
    hits.push(t); crawlHits.set(ip, hits);
    if (crawlHits.size > 5000) crawlHits.clear();
    return true;
  }

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    // Baseline security headers on every response (CSP is deferred: the SPA
    // and email-safe report markup use inline styles).
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');

    try {
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
      // One funnel: the React /app/start flow (paste → check → strip → Google).
      // The server-rendered landing and progress pages only serve when the
      // client build is absent (tests, cold deploys).
      if (req.method === 'GET' && path === '/') {
        if (hasClient()) { res.writeHead(302, { location: `/app/start${u.search}` }); return res.end(); }
        return html(res, 200, landingPage());
      }

      // Stripe webhooks - §10. Signature verified before anything is parsed.
      if (req.method === 'POST' && path === '/api/stripe/webhook' && billing) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        await new Promise((r) => req.on('end', r));
        const sig = req.headers['stripe-signature'] || '';
        const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
        const expected = require('crypto').createHmac('sha256', billing.webhookSecret)
          .update(`${parts.t}.${raw}`).digest('hex');
        if (!parts.v1 || parts.v1 !== expected) return json(res, 400, { error: 'bad signature' });
        // A failure here must be loud: Stripe retries on 500, and the log line is the only way to know why.
        let event; try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad payload' }); }
        try {
          const result = await billing.handleWebhook(event, billing.store);
          return json(res, 200, { received: true, handled: result.handled });
        } catch (e) {
          console.error(`stripe webhook ${event.type} ${event.id || ''} failed: ${e && e.message}`);
          return json(res, 500, { error: 'webhook failed' });
        }
      }

      if (req.method === 'POST' && path === '/api/crawl') {
        let body = '';
        req.on('data', (c) => { body += c; });
        await new Promise((r) => req.on('end', r));
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
        if (!parsed.url) return json(res, 400, { error: 'url required' });
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const session = readSession(req.headers.cookie, sessionSecret, now());
        let ownSite = false;
        if (session && dashStore && dashStore.websiteOf) {
          try {
            const site = await dashStore.websiteOf(session.tenantId);
            const host = new URL(parsed.url.startsWith('http') ? parsed.url : `https://${parsed.url}`).hostname.replace(/^www\./, '');
            ownSite = !!site && site.replace(/^www\./, '') === host;
          } catch { ownSite = false; }
        }
        if (!ownSite && !crawlAllowed(ip)) return json(res, 429, { error: 'That is a lot of checks in one hour - try again a little later.' });
        return handleCrawlRequest(res, parsed.url, { force: !!parsed.force, ownSite });
      }

      if (req.method === 'GET' && path.startsWith('/api/crawl/')) {
        const c = await store.getCrawl(path.split('/')[3]);
        if (!c) return json(res, 404, { error: 'unknown crawl' });
        // A failed crawl has a placeholder strip; the funnel must show its failure state, not a result card.
        return json(res, 200, { status: c.status, strip: c.status === 'complete' ? (c.strip || null) : null, checked_at: c.created_at || null });
      }

      if (req.method === 'GET' && path.startsWith('/check/')) {
        // Old links resume the same check inside the one funnel - never a second address prompt.
        if (hasClient()) { res.writeHead(302, { location: `/app/start?crawl=${encodeURIComponent(path.split('/')[2])}` }); return res.end(); }
        return html(res, 200, progressPage(path.split('/')[2]));
      }

      // Supabase Auth session bridge: the client finishes Google sign-in with
      // Supabase, then posts its access token here; we verify it against
      // Supabase, find-or-create the tenant, and set the app session cookie.
      if (req.method === 'POST' && path === '/api/session' && authBridge) {
        let body = '';
        req.on('data', (c) => { body += c; });
        await new Promise((r) => req.on('end', r));
        let parsed; try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
        if (!parsed.access_token) return json(res, 400, { error: 'access_token required' });
        const identity = await authBridge.verifySupabaseToken(parsed.access_token);
        if (!identity) return json(res, 401, { error: 'That sign-in could not be verified.' });
        const tenantId = await authBridge.findOrCreateTenantByGoogle(identity);
        const session = issueSession({ tenantId, secret: sessionSecret, now: now() });
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieFor(session) });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Google data-scope OAuth (§6 ladder steps 2–4) + §7 discovery.
      if (path.startsWith('/auth/google') && googleAuth) {
        const session = readSession(req.headers.cookie, sessionSecret, now());
        const handled = await handleGoogleAuth(req, res, u, session, {
          ...googleAuth, sessionSecret, now, issueSession, cookieFor,
          findOrCreateTenantByGoogle: authBridge ? authBridge.findOrCreateTenantByGoogle : null,
          activateSeat: agencyStore && agencyStore.activateSeat ? agencyStore.activateSeat : null,
          checkSeat: agencyStore && agencyStore.checkSeat ? agencyStore.checkSeat : null,
          adoptTenant: agencyStore && agencyStore.adoptTenant ? agencyStore.adoptTenant : null,
          consumeLink: store.magicLinks && store.magicLinks.markUsed ? (id) => store.magicLinks.markUsed(id, new Date(now()).toISOString()) : null,
        });
        if (handled) return undefined;
      }

      // Stripe Checkout + billing portal (§10). checkout injected only when
      // STRIPE_SECRET_KEY exists; routes 404 otherwise.
      if (req.method === 'POST' && path.startsWith('/api/checkout') && checkout) {
        const session = readSession(req.headers.cookie, sessionSecret, now());
        if (!session) return json(res, 401, { error: 'Sign in first.' });
        let body = '';
        req.on('data', (c) => { body += c; });
        await new Promise((r) => req.on('end', r));
        let parsed; try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
        try {
          if (path === '/api/checkout/audit') {
            const r = await checkout.audit({ tenantId: session.tenantId, kind: parsed.kind || 'audit_unlock', next: safeNext(parsed.next, '/app') });
            return json(res, 200, { url: r.url });
          }
          if (path === '/api/checkout/subscribe') {
            if (!parsed.tier) return json(res, 400, { error: 'tier required' });
            // Spec §5/§6: the return lands where the customer was, with the
            // change they tapped riding along so the tab (and the webhook)
            // can approve it the moment the plan is active.
            const r = await checkout.subscribe({
              tenantId: session.tenantId, tier: parsed.tier, cadence: parsed.cadence || 'monthly',
              next: safeNext(parsed.next), changeId: parsed.change_id ? String(parsed.change_id).slice(0, 64) : null,
            });
            // Email this to whoever pays (fix plan move 16): the same link, sent.
            const payer = String(parsed.payer_email || '').trim().toLowerCase();
            if (payer && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payer) && dashStore && dashStore.emailPayLink) {
              await dashStore.emailPayLink(session.tenantId, { to: payer, url: r.url, tier: parsed.tier }).catch(() => {});
              return json(res, 200, { url: null, emailed: payer });
            }
            return json(res, 200, { url: r.url });
          }
          if (path === '/api/checkout/portal') {
            const r = await checkout.portal({ tenantId: session.tenantId });
            return json(res, 200, { url: r.url });
          }
        } catch (err) {
          return json(res, 400, { error: 'We could not start that payment - try again in a moment.' });
        }
      }

      // Sign out (Settings → Sign out): expire the session cookie, land on the
      // sign-in view. POST from the app; GET works for a plain link too.
      if (path === '/auth/signout' && (req.method === 'POST' || req.method === 'GET')) {
        res.writeHead(302, { location: '/app/start', 'set-cookie': clearCookie(), 'cache-control': 'no-store' });
        return res.end();
      }

      // Report-stream List-Unsubscribe target (§17).
      if (req.method === 'GET' && path === '/m/unsubscribe') {
        // Writes the same flag as the Settings toggle (richer-platform spec §6).
        const tid = u.searchParams.get('t');
        if (tid && /^[0-9a-f-]{36}$/i.test(tid) && dashStore && dashStore.setEmailReports) await dashStore.setEmailReports(tid, false).catch(() => {});
        return html(res, 200, '<p style="font-family:sans-serif">You are unsubscribed from weekly report emails. Alerts about breakage still reach you, those protect your money. Turn reports back on any time in Settings.</p>');
      }

      // Magic-link redemption: single-use, purpose-routed (§12).
      if (req.method === 'GET' && path.startsWith('/m/')) {
        const token = path.slice(3);
        const r = await peekLink(token, now(), store.magicLinks);
        if (!r.ok) {
          // An invite that expired names the agency and says who can resend it (agency plan move 12).
          if (r.link && r.link.purpose === 'join_agency' && agencyStore && agencyStore.inviteContext) {
            const ctx = await agencyStore.inviteContext(r.link.target_id).catch(() => null);
            const who = ctx && ctx.agency ? ctx.agency : 'your agency';
            const msg = ctx && ctx.status === 'active' ? `You have already joined ${who}. <a href="/app/agency">Open the console</a>.`
              : `This invite to ${who} has ${r.reason === 'used' ? 'already been used' : 'expired'}. Ask an admin at ${who} to resend it from Settings, Seats.`;
            return html(res, 410, `<p style="font-family:sans-serif">${msg}</p>`);
          }
          const msg = r.reason === 'expired' ? 'This link has expired. Request a fresh one from your latest email, or sign in.'
            : r.reason === 'used' ? 'This link was already used. Open your dashboard instead.'
              : 'This link is not valid.';
          return html(res, 410, `<div style="font-family:sans-serif;max-width:36em;margin:48px auto;padding:0 20px;line-height:1.5"><p>${msg}</p><p><a href="/app" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#2563EB;color:#fff;text-decoration:none;font-weight:500">Open your dashboard</a></p><p style="color:#565b63;font-size:14px">Signed out? The dashboard asks you to sign in with Google, then lands where the link was going.</p></div>`);
        }
        // Agency joins (fix plan move 14) do not sign anyone in: they set a short
        // join cookie and start the Google sign-in, which binds the identity.
        // The link is consumed when the identity binds, not here (agency plan
        // move 4), so an abandoned Google screen does not kill the invite.
        if (r.link.purpose === 'join_agency' || r.link.purpose === 'join_account') {
          const value = `${r.link.purpose === 'join_agency' ? `seat:${r.link.target_id}` : `account:${r.link.tenant_id}`}.${r.link.id}`;
          res.writeHead(302, { location: '/auth/google/start?step=discovery&switch=1', 'set-cookie': `insyt_join=${value}; HttpOnly; Path=/; Max-Age=900; SameSite=Lax` });
          return res.end();
        }
        await store.magicLinks.markUsed(r.link.id, new Date(now()).toISOString());
        // Redemption signs the tenant in (one tap from inbox - master §5).
        // A viewer link signs in read-only; an approve-join link adds the requester (fix plan move 12).
        if (r.link.purpose === 'join_approve' && dashStore && dashStore.approveJoin) await dashStore.approveJoin(r.link.tenant_id, r.link.target_id).catch(() => {});
        const session = issueSession({ tenantId: r.link.tenant_id, secret: sessionSecret, now: now(), role: r.link.purpose === 'join_viewer' ? 'viewer' : 'owner' });
        const dest = {
          join_viewer: '/app',
          join_approve: '/app/settings?joined=1',
          view_report: r.link.target_id ? `/app/report/${r.link.target_id}` : '/app',
          approve_all: '/app/approvals',
          approve_one: '/app/approvals',
          revert: r.link.target_id ? `/app/revert/${r.link.target_id}` : '/app/history',
          reconnect: '/app/settings',
          resume_journey: '/app/journey',
        }[r.link.purpose] || '/app';
        res.writeHead(302, { location: dest, 'set-cookie': cookieFor(session) });
        return res.end();
      }

      // ---- JSON API for the React client (§11 screens over dashStore)
      if (path.startsWith('/api/app') && dashStore) {
        const session = readSession(req.headers.cookie, sessionSecret, now());
        if (!session) return json(res, 401, { error: 'Sign in first.' });
        const t = session.tenantId;
        const sub = path.slice('/api/app'.length) || '/';
        let role = session.role || 'owner';
        // A managed tenant in read-only mode (agency plan move 11): the client
        // reads everything; approvals and undo belong to the agency.
        const managed = dashStore.managed ? await dashStore.managed(t).catch(() => null) : null;
        if (managed && managed.client_mode === 'read_only' && role === 'owner') role = 'viewer';
        // A viewer (fix plan move 12) reads everything and changes nothing.
        if (role === 'viewer' && req.method === 'POST' && sub !== '/event') return json(res, 403, { error: managed && managed.client_mode === 'read_only' ? `${managed.agency_name} looks after approvals for this account. Ask them.` : 'View only. Approvals stay with the owner.', view_only: true });
        const accessWithRole = async () => { const a = await accessFor(dashStore, t); return a ? { ...a, role } : a; };
        // Connected data (Settings → "See what Insyt reads"): the raw objects
        // each granted Google API returns for this tenant, plus the two Ads
        // actions that run through the normal approve → apply → Undo path.
        if (sub.startsWith('/connected') && connected) {
          // Reads at every level; the two Ads writes need a plan (spec §2).
          if (req.method === 'POST' && !(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
          return connected.handle(req, res, sub.slice('/connected'.length), t);
        }
        if (req.method === 'GET') {
          // The gate, on its own: the client polls this after Checkout (spec §6).
          if (sub === '/access') return json(res, 200, { access: await accessWithRole() });
          if (sub === '/home') {
            const [health, pending, cumulative, reports, streak, plan, spend, currency] = await Promise.all([
              dashStore.healthLatest(t), dashStore.pendingApprovals(t), dashStore.cumulative(t), dashStore.reports(t),
              dashStore.approvalStreak ? dashStore.approvalStreak(t) : 0,
              dashStore.planPosition ? dashStore.planPosition(t) : null,
              // Spend position ships with the audit engine phase; until the
              // store grows the method the card simply does not render.
              dashStore.spendPosition ? dashStore.spendPosition(t) : null,
              dashStore.accountCurrency ? dashStore.accountCurrency(t) : 'USD',
            ]);
            return json(res, 200, { health, pending, cumulative, reports, streak, plan, spend, currency, access: await accessWithRole() });
          }
          // Home overview (richer-platform spec §2/§8): money strip, the week's
          // story, the three accounts, alerts and the 28-day series in one trip.
          if (sub === '/overview') {
            const overview = dashStore.overview ? await dashStore.overview(t, new Date(now())) : null;
            // The $20 tail (fix plan move 13): say when checks have gone monthly.
            if (overview && opsStore && opsStore.weeklyCadence) { try { overview.cadence = (await opsStore.weeklyCadence(t, now())).cadence; } catch { overview.cadence = 'weekly'; } }
            // A report held for the agency's review (agency plan move 9).
            if (overview && dashStore.heldReport) { try { const h = await dashStore.heldReport(t); overview.held_report = h ? { since: h.created_at } : null; } catch { overview.held_report = null; } }
            return json(res, 200, { overview, access: await accessWithRole() });
          }
          if (sub === '/approvals') return json(res, 200, { pending: await dashStore.pendingApprovals(t), access: await accessWithRole() });
          if (sub === '/ledger') return json(res, 200, { entries: await dashStore.ledger(t), pending: await dashStore.pendingApprovals(t), receipts: dashStore.receipts ? (await dashStore.receipts(t, new Date(now()))).by_change : {}, access: await accessWithRole() });
          if (sub === '/reports') return json(res, 200, { reports: await dashStore.reports(t) });
          if (sub === '/settings') return json(res, 200, { settings: await dashStore.settings(t, new Date(now())), access: await accessWithRole() });
          if (sub === '/runs') return json(res, 200, { runs: dashStore.runs ? await dashStore.runs(t) : [] });
          if (sub === '/discovery') return json(res, 200, await dashStore.discovery(t));
          if (sub === '/plan') return json(res, 200, { plan: await dashStore.planOptions(t) });
          if (sub === '/first-fix') return json(res, 200, { fix: await dashStore.firstFix(t) });
          if (sub === '/journey') return json(res, 200, { journey: await dashStore.journey(t) });
          // §4.5 "what have I told you never to touch?"
          if (sub === '/exceptions') return json(res, 200, { exceptions: dashStore.exceptions ? await dashStore.exceptions(t) : [] });
          if (sub === '/fence-options') return json(res, 200, { options: dashStore.fenceOptions ? await dashStore.fenceOptions(t) : [] });
          if (sub === '/businesses') return json(res, 200, { businesses: dashStore.businesses ? await dashStore.businesses(t) : [], role });
          if (sub.startsWith('/revert-preview/')) { const p = dashStore.revertPreview ? await dashStore.revertPreview(t, sub.split('/')[2]) : null; return json(res, p ? 200 : 404, p || { error: 'Not found.' }); }
          // §5 consumer door + §5.1 setup checklist
          if (sub === '/drafts') return json(res, 200, { drafts: dashStore.drafts ? await dashStore.drafts(t) : [] });
          // §7 assistant (per-tenant flag)
          if (sub === '/chat') {
            if (!(dashStore.assistantEnabled && await dashStore.assistantEnabled(t))) return json(res, 404, { error: 'Not available yet.' });
            return json(res, 200, await dashStore.chatTranscript(t, u.searchParams.get('conversation') || null));
          }
          if (sub === '/setup') return json(res, 200, dashStore.setupSteps ? await dashStore.setupSteps(t) : { steps: [] });
          if (sub.startsWith('/report/')) {
            const id = sub.split('/')[2];
            if (!id || id === 'null' || id === 'undefined') return json(res, 404, { error: 'Report not found.' });
            const r = await dashStore.reportData(t, id);
            if (r && r.held) return json(res, 404, { error: 'Your agency is reviewing this report. It arrives once they have looked at it.', held: true });
            if (!r) return json(res, 404, { error: 'Report not found.' });
            // Pending changes ride along so each finding can carry its
            // "Fix this" (spec §4, Report), and the gate decides what it does.
            return json(res, 200, { report: r, pending: await dashStore.pendingApprovals(t), receipts: dashStore.receipts ? (await dashStore.receipts(t, new Date(now()))).by_finding : {}, access: await accessWithRole() });
          }
        }
        if (req.method === 'POST') {
          // Body-carrying endpoints: autopilot categories and the
          // request-a-change composer. Both write through the store so demo
          // and tests can stub them; both stay no-ops for stores without the
          // methods rather than erroring the whole API.
          if (sub === '/setup/provision') {
            try {
              const r = dashStore.provisionSetup ? await dashStore.provisionSetup(t) : { error: 'Not available yet.' };
              return json(res, r.error ? 501 : 200, r);
            } catch (e) { return json(res, 500, { error: 'We could not finish the setup automatically. We logged it and will follow up.' }); }
          }
          if (sub === '/chat/consent') {
            if (!(dashStore.assistantEnabled && await dashStore.assistantEnabled(t))) return json(res, 404, { error: 'Not available yet.' });
            return json(res, 200, await dashStore.chatConsent(t));
          }
          if (sub === '/autopilot' || sub === '/request-change' || sub === '/event' || sub === '/chat' || sub === '/approve-batch' || sub === '/business' || sub === '/emails' || sub === '/confirm' || sub === '/access-request' || sub === '/exceptions' || sub === '/pause' || sub === '/invite' || /^\/alerts\/[^/]+\/expected$/.test(sub) || sub === '/add-business' || sub === '/switch-tenant' || sub.startsWith('/snooze/') || sub.startsWith('/approve-part/') || sub.startsWith('/dismiss/') || sub.startsWith('/drafts')) {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', async () => {
              let parsed; try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
              try {
                // §11 telemetry: client-side interactions. Fire-and-forget,
                // never an error the UI has to handle.
                if (sub === '/chat') {
                  if (!(dashStore.assistantEnabled && await dashStore.assistantEnabled(t))) return json(res, 404, { error: 'Not available yet.' });
                  const text = String(parsed.text || '').trim();
                  if (!text) return json(res, 400, { error: 'Say what you would like to know or change.' });
                  const r = await dashStore.chat(t, text, parsed.conversation_id || null);
                  return json(res, 200, r);
                }
                // Later, partial yes, leave alone (fix plan moves 6 and 7).
                if (sub.startsWith('/snooze/')) {
                  if (!dashStore.snoozeChange) return json(res, 501, { error: 'Not available yet.' });
                  return json(res, 200, await dashStore.snoozeChange(t, sub.split('/')[2], parsed.days || 7));
                }
                if (sub.startsWith('/approve-part/')) {
                  if (!(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
                  await dashStore.approveChange(t, sub.split('/')[2], { keep: Array.isArray(parsed.keep) ? parsed.keep.map(String).slice(0, 200) : null });
                  return json(res, 200, { ok: true });
                }
                if (sub === '/exceptions') {
                  if (!dashStore.addFence) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.addFence(t, { target: parsed.target, summary_text: parsed.summary_text, change_id: parsed.change_id || null });
                  return json(res, r.ok ? 200 : 400, r);
                }
                // Confirm (fix plan move 1): the chosen accounts and the fences ride along.
                if (sub === '/confirm') {
                  const run = await confirmAndStart(t, { link: Array.isArray(parsed.link) ? parsed.link : [], exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [] });
                  return json(res, 200, { ok: true, run_id: run ? run.id : null });
                }
                if (sub === '/access-request') {
                  if (!dashStore.accessRequest) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.accessRequest(t, parsed.email, process.env.APP_BASE_URL || 'https://app.tryinsyt.com');
                  return json(res, r.ok ? 200 : 400, r);
                }
                // Settings writes (richer-platform spec §6): free at every level,
                // they touch nothing in Google.
                if (sub === '/business') {
                  if (!dashStore.setBusiness) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.setBusiness(t, { name: parsed.name, website: parsed.website, timezone: parsed.timezone });
                  // A new website (fix plan move 10): look again for accounts and check it tomorrow morning.
                  if (r.ok && r.website_url) {
                    if (rediscover) rediscover(t).catch((e) => console.error(`rediscover after website change failed for ${t}: ${e.message}`));
                    if (opsStore && queue) {
                      const day = new Date(now()).toISOString().slice(0, 10);
                      try { const run = await opsStore.enqueueRun({ tenant_id: t, type: 'triggered', status: 'queued', idempotency_key: `site:${t}:${day}` }); if (run) await queue.enqueue('runs-triggered', run); } catch { /* already queued today */ }
                    }
                  }
                  return json(res, r.ok ? 200 : 400, r.ok ? r : { error: 'Nothing to save.' });
                }
                if (/^\/alerts\/[^/]+\/expected$/.test(sub)) {
                  if (!dashStore.expectAlert) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.expectAlert(t, sub.split('/')[2], parsed.until, new Date(now()));
                  return json(res, r.ok ? 200 : 400, r);
                }
                // People (fix plan move 12): a viewer invite, another business, switching between them.
                if (sub === '/invite') {
                  if (!dashStore.inviteViewer) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.inviteViewer(t, parsed.email, { baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com', now: now() });
                  return json(res, r.ok ? 200 : 400, r);
                }
                if (sub === '/add-business') {
                  if (!dashStore.addBusiness) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.addBusiness(t, parsed.website);
                  if (!r.ok) return json(res, 400, r);
                  if (rediscover) { try { await rediscover(r.tenant_id); } catch (e) { console.error(`rediscover for new business ${r.tenant_id} failed: ${e.message}`); } }
                  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieFor(issueSession({ tenantId: r.tenant_id, secret: sessionSecret, now: now() })) });
                  return res.end(JSON.stringify({ ok: true, tenant_id: r.tenant_id }));
                }
                if (sub === '/switch-tenant') {
                  if (!dashStore.switchTenant) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.switchTenant(t, String(parsed.tenant_id || ''));
                  if (!r.ok) return json(res, 403, { error: 'That business is not yours.' });
                  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieFor(issueSession({ tenantId: String(parsed.tenant_id), secret: sessionSecret, now: now() })) });
                  return res.end(JSON.stringify({ ok: true }));
                }
                // Pause until a date (fix plan move 13); Stripe stops the bill and resumes it itself.
                if (sub === '/pause') {
                  if (!dashStore.pauseTenant) return json(res, 501, { error: 'Not available yet.' });
                  const r = await dashStore.pauseTenant(t, parsed.until);
                  if (!r.ok) return json(res, 400, r);
                  if (r.stripe_subscription_id && checkout && checkout.pause) { try { await checkout.pause(r.stripe_subscription_id, r.paused_until); } catch (e) { console.error(`stripe pause failed for ${t}: ${e.message}`); } }
                  return json(res, 200, { ok: true, paused_until: r.paused_until });
                }
                if (sub === '/emails') {
                  if (!dashStore.setEmailReports) return json(res, 501, { error: 'Not available yet.' });
                  return json(res, 200, await dashStore.setEmailReports(t, !!parsed.reports));
                }
                // Batch yes (richer-platform spec §2.4): same gate as approve.
                if (sub === '/approve-batch') {
                  if (!(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
                  const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).slice(0, 50) : [];
                  if (!ids.length) return json(res, 400, { error: 'Nothing selected to approve.' });
                  let r;
                  if (dashStore.approveBatch) r = await dashStore.approveBatch(t, ids);
                  else { for (const id of ids) await dashStore.approveChange(t, id); r = { approved: ids.length, requested: ids.length }; }
                  return json(res, 200, { ok: true, ...r });
                }
                if (sub === '/event') {
                  if (dashStore.trackEvent) dashStore.trackEvent(t, String(parsed.name || ''), parsed.props || {}, parsed.session || null).catch(() => {});
                  return json(res, 200, { ok: true });
                }
                if (sub.startsWith('/dismiss/')) {
                  await dashStore.dismissChange(t, sub.split('/')[2], { reason: parsed.reason || null, expandedFirst: !!parsed.expanded_first });
                  return json(res, 200, { ok: true });
                }
                if (sub === '/drafts') {
                  if (!dashStore.createDraft) return json(res, 501, { error: 'Not available yet.' });
                  const draft = await dashStore.createDraft(t, { template: parsed.template || 'generic', inputs: parsed.inputs || {} });
                  return json(res, 200, { ok: true, draft });
                }
                {
                  const m = /^\/drafts\/([^/]+)\/(approve|enable|dismiss|edit)$/.exec(sub);
                  if (m) {
                    // Creating or switching on an ad writes to Google Ads: plan only.
                    if ((m[2] === 'approve' || m[2] === 'enable') && !(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
                    const r = dashStore.draftAction ? await dashStore.draftAction(t, m[1], m[2], parsed) : null;
                    if (!r) return json(res, 404, { error: 'Unknown draft.' });
                    if (r.error) return json(res, 409, { error: r.error, ...(r.steps ? { steps: r.steps } : {}) });
                    return json(res, 200, { ok: true, ...r });
                  }
                }
                if (sub === '/autopilot') {
                  if (!dashStore.setAutopilot) return json(res, 501, { error: 'Not available yet.' });
                  // Autopilot is a plan feature: the toggles need an active plan
                  // (the worker additionally requires the Autopilot tier).
                  if (!(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
                  const categories = await dashStore.setAutopilot(t, parsed.categories || parsed);
                  return json(res, 200, { ok: true, categories });
                }
                const text = String(parsed.text || '').trim();
                if (!text) return json(res, 400, { error: 'Tell us what you would like changed.' });
                if (!dashStore.requestChange) return json(res, 501, { error: 'Not available yet.' });
                const rc = await dashStore.requestChange(t, text);
                return json(res, 200, { ok: true, ...(rc && typeof rc === 'object' ? rc : {}) });
              } catch {
                return json(res, 500, { error: 'Something went wrong. Try again.' });
              }
            });
            return;
          }
          // The two writes the whole funnel turns on (spec §2): a yes on a fix,
          // and its undo. Both need a plan; the client opens the Plan sheet on 402.
          if (sub.startsWith('/approve/')) {
            if (!(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
            await dashStore.approveChange(t, sub.split('/')[2]);
            return json(res, 200, { ok: true });
          }
          if (sub.startsWith('/revert/')) {
            // Undo stays free for 30 days after cancelling (fix plan move 13).
            const a = await accessWithRole();
            const undoFree = !a || a.level === 'active' || (a.undo_until && Date.parse(a.undo_until) > now());
            if (!undoFree) return json(res, 402, PLAN_REQUIRED);
            const r = await dashStore.requestRevert(t, sub.split('/')[2]);
            return json(res, 200, r && r.ok === false ? { ok: false, reason: r.reason } : { ok: true });
          }
          if (/^\/alerts\/[^/]+\/ack$/.test(sub)) {
            if (!dashStore.ackAlert) return json(res, 501, { error: 'Not available yet.' });
            return json(res, 200, await dashStore.ackAlert(t, sub.split('/')[2]));
          }
          if (sub === '/join-request') {
            if (!dashStore.joinRequest) return json(res, 501, { error: 'Not available yet.' });
            const r = await dashStore.joinRequest(t, { baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com', now: now() });
            return json(res, r.ok ? 200 : 400, r);
          }
          if (sub === '/resume') {
            if (!dashStore.resumeTenant) return json(res, 501, { error: 'Not available yet.' });
            const r = await dashStore.resumeTenant(t);
            if (r.stripe_subscription_id && checkout && checkout.resume) { try { await checkout.resume(r.stripe_subscription_id); } catch (e) { console.error(`stripe resume failed for ${t}: ${e.message}`); } }
            return json(res, 200, { ok: true });
          }
          // Look again for accounts (fix plan move 10), on demand.
          if (sub === '/rediscover') {
            if (!rediscover) return json(res, 501, { error: 'Not available yet.' });
            try {
              const r = await rediscover(t);
              return json(res, 200, { ok: true, inserted: r.inserted, matched: r.matched, fresh_unmatched: r.fresh_unmatched || [] });
            } catch (e) { return json(res, 502, { error: 'Google did not answer. Try again in a minute, or reconnect from this page.' }); }
          }
          if (sub.startsWith('/retry/')) {
            if (!(await planActive(dashStore, t))) return json(res, 402, PLAN_REQUIRED);
            if (!dashStore.retryChange) return json(res, 501, { error: 'Not available yet.' });
            return json(res, 200, await dashStore.retryChange(t, sub.split('/')[2]));
          }
          if (/^\/exceptions\/[^/]+\/clear$/.test(sub)) {
            const ok = dashStore.clearException ? await dashStore.clearException(t, sub.split('/')[2]) : false;
            return json(res, ok ? 200 : 404, { ok });
          }
          if (sub === '/recheck') {
            // "Check again now": a triggered run, at most one per tenant per hour.
            if (!opsStore || !queue) return json(res, 503, { error: 'Checks are paused right now - try again shortly.' });
            const hour = new Date(now()).toISOString().slice(0, 13);
            try {
              const run = await opsStore.enqueueRun({ tenant_id: t, type: 'triggered', status: 'queued', idempotency_key: `recheck:${t}:${hour}` });
              await queue.enqueue('runs-triggered', run);
              return json(res, 200, { ok: true, run_id: run.id });
            } catch (e) {
              if (/duplicate|23505|409/.test(String(e && e.message))) return json(res, 200, { ok: true, run_id: null, note: 'A fresh check is already on its way.' });
              console.error(`recheck enqueue failed for ${t}: ${e && e.message}`);
              return json(res, 500, { error: 'something went wrong on our side' });
            }
          }
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- agency console API (master §13). Binding: no auto-apply - every
      // write here is an explicit seat action, logged with the seat.
      if (path.startsWith('/api/agency') && agencyStore) {
        const session = readSession(req.headers.cookie, sessionSecret, now());
        if (!session) return json(res, 401, { error: 'Sign in first.' });
        // One login, several agencies (agency plan move 4): the insyt_agency
        // cookie picks the seat; a disabled seat is told so.
        const allSeats = agencyStore.seatsByTenant ? await agencyStore.seatsByTenant(session.tenantId) : null;
        let seat = null;
        if (allSeats) {
          const wanted = ((req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('insyt_agency=')) || '').slice('insyt_agency='.length);
          const live = allSeats.filter((x) => x.status === 'active');
          seat = live.find((x) => x.agency_id === wanted) || live[0] || null;
          if (!seat && allSeats.length) return json(res, 403, { error: `Your seat at ${(allSeats[0].agency && allSeats[0].agency.name) || 'the agency'} is disabled. Ask an admin there to enable it.`, code: 'seat_disabled' });
        } else seat = await agencyStore.seatByTenant(session.tenantId);
        if (!seat) return json(res, 403, { error: 'This sign-in has no agency seat.', code: 'no_seat' });
        const ag = seat.agency_id;
        const sub = path.slice('/api/agency'.length) || '/';
        const canWrite = seat.role === 'admin' || seat.role === 'am';
        const isAdmin = seat.role === 'admin';
        // Account managers see and touch their assigned accounts, plus the
        // unassigned ones (agency plan move 7). Admins and read-only see all.
        const scope = seat.role === 'am' ? { seatId: seat.id } : null;

        if (req.method === 'GET') {
          if (sub === '/me') return json(res, 200, { seat, agency: await agencyStore.agency(ag), agencies: (allSeats || [seat]).filter((x) => !x.status || x.status === 'active').map((x) => ({ id: x.agency_id, name: x.agency ? x.agency.name : null, role: x.role })) });
          if (sub === '/portfolio') return json(res, 200, { accounts: await agencyStore.portfolio(ag, scope) });
          if (sub === '/triage') return json(res, 200, { queue: await agencyStore.triage(ag, scope, { snoozed: u.searchParams.get('snoozed') === '1', now: new Date(now()).toISOString() }) });
          if (sub === '/counts' && agencyStore.counts) return json(res, 200, await agencyStore.counts(ag, scope, new Date(now()).toISOString()));
          if (sub === '/review') return json(res, 200, { queue: await agencyStore.reviewQueue(ag, scope) });
          if (sub === '/brand') return json(res, 200, { kit: (await agencyStore.brandKit(ag)) || null });
          if (sub === '/seats') return json(res, 200, { seats: await agencyStore.seats(ag) });
          if (sub === '/credits') return json(res, 200, await agencyStore.credits(ag));
          if (sub === '/log') {
            const entries = await agencyStore.auditLog(ag, { accountId: u.searchParams.get('account') || null, before: u.searchParams.get('before') || null, limit: u.searchParams.get('limit') || 100 });
            if (u.searchParams.get('format') === 'csv') {
              const cell = (v) => `"${String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replace(/"/g, '""')}"`;
              const lines = ['when,seat,event,detail', ...entries.map((e) => [e.created_at, e.seat ? (e.seat.name || e.seat.email) : 'system', e.event, e.detail].map(cell).join(','))];
              res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="insyt-agency-log.csv"' });
              return res.end(lines.join('\n'));
            }
            return json(res, 200, { entries });
          }
          if (sub === '/accounts') return json(res, 200, { accounts: await agencyStore.accountsList(ag, { includeRemoved: u.searchParams.get('all') === '1' }, scope) });
          if (sub === '/billing') return json(res, 200, await agencyStore.billing(ag, new Date(now()).toISOString()));
          if (sub === '/campaigns') return json(res, 200, { campaigns: await agencyStore.campaignsFor(ag, scope) });
          if (sub === '/pacing') return json(res, 200, { accounts: await agencyStore.pacing(ag, new Date(now()).toISOString(), scope) });
          if (sub === '/alerts') return json(res, 200, { alerts: await agencyStore.alertsFor(ag, scope) });
          if (sub === '/drafts') return json(res, 200, { drafts: await agencyStore.draftsFor(ag, scope) });
          {
            const m = /^\/accounts\/([^/]+)$/.exec(sub);
            if (m && agencyStore.accountDetail) {
              const d = await agencyStore.accountDetail(ag, m[1], scope);
              if (!d) return json(res, 404, { error: 'This account is not in your portfolio.' });
              return json(res, 200, d);
            }
          }
        }
        // Copying a brief is a read, logged (agency plan move 12): read-only seats do it too.
        if (req.method === 'POST' && /^\/brief\/[^/]+$/.test(sub)) {
          if (agencyStore.logEvent) await agencyStore.logEvent(ag, seat.id, 'brief_copied', { change_id: sub.split('/')[2] }).catch(() => {});
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && sub === '/switch') {
          let body = '';
          req.on('data', (c) => { body += c; });
          await new Promise((r) => req.on('end', r));
          let parsed; try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
          const target = (allSeats || []).find((x) => x.status === 'active' && x.agency_id === parsed.agency_id);
          if (!target) return json(res, 404, { error: 'No seat at that agency.' });
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `insyt_agency=${target.agency_id}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax` });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (req.method === 'POST') {
          if (!canWrite) {
            if (agencyStore.logEvent) await agencyStore.logEvent(ag, seat.id, 'write_refused', { action: sub, reason: 'view_only' }).catch(() => {});
            return json(res, 403, { error: 'This seat is view only. Ask an admin to change your role under Seats.', code: 'view_only' });
          }
          let body = '';
          req.on('data', (c) => { body += c; });
          await new Promise((r) => req.on('end', r));
          let parsed; try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
          // Every write stays home (agency plan move 1): the store answers
          // { ok: false, reason } for anything outside this agency's active
          // accounts, and the route turns that into a sentence.
          const refused = (r) => {
            if (!r || r.ok !== false) return false;
            if (r.reason === 'brief_only') json(res, 403, { error: 'This account is brief-only. Send the brief; do not apply.', code: 'brief_only' });
            else json(res, 404, { error: 'This item is not on one of your accounts any more. Refresh the queue.', code: 'not_owned' });
            return true;
          };

          if (sub === '/approve-batch') {
            if (!Array.isArray(parsed.ids) || !parsed.ids.length) return json(res, 400, { error: 'ids required' });
            const r = await agencyStore.approveBatch(ag, seat.id, parsed.ids, scope);
            return json(res, 200, { ok: true, approved: r.approved, skipped: r.skipped || [] });
          }
          if (sub.startsWith('/approve/')) {
            const r = await agencyStore.approveChange(ag, seat.id, sub.split('/')[2], scope);
            if (refused(r)) return undefined; return json(res, 200, { ok: true });
          }
          if (sub.startsWith('/dismiss/')) {
            const r = await agencyStore.dismissChange(ag, seat.id, sub.split('/')[2], parsed.reason, scope);
            if (refused(r)) return undefined; return json(res, 200, { ok: true });
          }
          if (sub.startsWith('/snooze/')) {
            const r = await agencyStore.snoozeChange(ag, seat.id, sub.split('/')[2], parsed.days, parsed.reason, scope);
            if (refused(r)) return undefined; return json(res, 200, { ok: true, until: r.until });
          }
          if (sub.startsWith('/targets/')) {
            const row = await agencyStore.setTargets(ag, seat.id, sub.split('/')[2], parsed, scope);
            if (!row) return json(res, 404, { error: 'Unknown account.' });
            return json(res, 200, { ok: true });
          }
          if (/^\/alerts\/[^/]+\/ack$/.test(sub)) { const r = await agencyStore.ackAlert(ag, seat.id, sub.split('/')[2], scope); if (refused(r)) return undefined; return json(res, 200, { ok: true }); }
          if (sub === '/drafts') {
            if (!parsed.account_id || !parsed.template) return json(res, 400, { error: 'account_id and template required' });
            const row = await agencyStore.createDraft(ag, seat.id, parsed, scope);
            if (!row) return json(res, 404, { error: 'Unknown account.' });
            return json(res, 200, { ok: true, draft: row });
          }
          {
            const m = /^\/drafts\/([^/]+)\/(approve|enable|dismiss|edit)$/.exec(sub);
            if (m) {
              const r = m[2] === 'edit'
                ? await agencyStore.editDraft(ag, seat.id, m[1], parsed.ad_groups || [])
                : await agencyStore.draftAction(ag, seat.id, m[1], m[2]);
              if (!r) return json(res, 404, { error: 'Unknown draft.' });
              if (r.error) return json(res, 409, { error: r.error, ...(r.steps ? { steps: r.steps } : {}) });
              return json(res, 200, { ok: true, ...r });
            }
          }
          if (/^\/report\/[^/]+\/approve$/.test(sub)) { const r = await agencyStore.approveReport(ag, seat.id, sub.split('/')[2], scope); if (refused(r)) return undefined; return json(res, 200, { ok: true }); }
          if (/^\/report\/[^/]+\/reject$/.test(sub)) { const r = await agencyStore.rejectReport(ag, seat.id, sub.split('/')[2], parsed.reason, scope); if (refused(r)) return undefined; return json(res, 200, { ok: true }); }
          if (sub === '/brand') { const r = await agencyStore.saveBrandKit(ag, seat.id, parsed); return json(res, 200, { ok: true, version: r.version }); }
          if (sub === '/accounts') {
            if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
            if (!parsed.display_name) return json(res, 400, { error: 'display_name required' });
            const row = await agencyStore.addAccount(ag, seat.id, parsed, { baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com', now: now() });
            return json(res, 200, { ok: true, account: row, requested: !!parsed.email });
          }
          {
            const m = /^\/accounts\/([^/]+)\/(pause|resume|remove)$/.exec(sub);
            if (m) {
              if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
              const status = m[2] === 'pause' ? 'paused' : m[2] === 'resume' ? 'active' : 'removed';
              const r = await agencyStore.setAccountStatus(ag, seat.id, m[1], status);
              if (refused(r)) return undefined;
              return json(res, 200, { ok: true });
            }
          }
          {
            // Three switches on the row (agency plan move 7).
            const m = /^\/accounts\/([^/]+)\/settings$/.exec(sub);
            if (m) {
              if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
              const r = await agencyStore.updateAccount(ag, seat.id, m[1], parsed);
              if (!r || r.ok === false) {
                if (r && r.reason === 'seat') return json(res, 400, { error: 'That seat is not active at this agency.' });
                if (r && r.reason === 'nothing') return json(res, 400, { error: 'Nothing to change.' });
                return json(res, 404, { error: 'Unknown account.' });
              }
              return json(res, 200, { ok: true, ...r });
            }
          }
          {
            // Undo from the seat (agency plan move 8).
            const m = /^\/accounts\/([^/]+)\/revert\/([^/]+)$/.exec(sub);
            if (m) {
              const r = await agencyStore.revertChange(ag, seat.id, m[1], m[2], scope);
              if (r && r.ok === false && r.reason === 'state') return json(res, 409, { error: r.error || 'Only applied changes can be undone.' });
              if (refused(r)) return undefined;
              return json(res, 200, { ok: true });
            }
          }
          {
            // Request access later, or again (agency plan move 5).
            const m = /^\/accounts\/([^/]+)\/request$/.exec(sub);
            if (m) {
              if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
              const r = await agencyStore.requestAccess(ag, seat.id, m[1], parsed.email, { baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com', now: now() });
              if (!r || r.ok === false) {
                if (r && r.reason === 'email') return json(res, 400, { error: 'That does not look like an email address.' });
                if (r && r.reason === 'connected') return json(res, 409, { error: 'This account is already connected.' });
                if (r && r.reason === 'send_failed') return json(res, 502, { error: 'Could not send the email. Try again in a minute.' });
                return json(res, 404, { error: 'Unknown account.' });
              }
              return json(res, 200, { ok: true, at: r.at });
            }
          }
          if (sub === '/seats') {
            if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
            const row = await agencyStore.addSeat(ag, seat.id, parsed, { baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com', now: now() });
            if (row && row.error) return json(res, 409, { error: row.error });
            return json(res, 200, { ok: true, seat: row, resent: !!(row && row.resent) });
          }
          {
            const m = /^\/seats\/([^/]+)\/resend$/.exec(sub);
            if (m) {
              if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
              const r = await agencyStore.resendInvite(ag, seat.id, m[1], { baseUrl: process.env.APP_BASE_URL || 'https://app.tryinsyt.com', now: now() });
              if (!r || r.ok === false) return json(res, r && r.reason === 'not_invited' ? 409 : 404, { error: r && r.reason === 'not_invited' ? 'This seat has already joined.' : 'Unknown seat.' });
              return json(res, 200, { ok: true, invite: r.invite });
            }
          }
          if (sub.startsWith('/seats/')) {
            if (!isAdmin) return json(res, 403, { error: 'Admin only.' });
            const r = await agencyStore.updateSeat(ag, seat.id, sub.split('/')[2], parsed);
            if (r && r.ok === false) {
              if (r.reason === 'self') return json(res, 409, { error: 'You cannot disable or remove your own seat. Ask another admin.' });
              if (r.reason === 'not_found') return json(res, 404, { error: 'Unknown seat.' });
              return json(res, 400, { error: 'Nothing to change.' });
            }
            return json(res, 200, { ok: true });
          }
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- ops console (internal)
      if (path.startsWith('/ops') && opsStore) {
        // Four ops buttons (fix plan move 15) ride on the same console.
        const handled = await handleOps(req, res, u, { opsStore, queue, opsToken, rediscover });
        if (handled) return undefined;
      }

      // ---- React SPA (when built): assets are public; /app* GETs get the shell.
      // The client handles session state itself via /api/app (401 → sign-in view).
      if (req.method === 'GET' && path.startsWith('/app') && hasClient()) {
        const rel = path.slice('/app'.length).replace(/^\//, '');
        if (rel && serveClientFile(res, rel)) return undefined;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(fs.readFileSync(clientIndex));
      }

      // ---- authed dashboard (server-rendered fallback, §11 screens 2, 5–12)
      if (path.startsWith('/app') && dashStore) {
        const session = readSession(req.headers.cookie, sessionSecret, now());
        if (!session) {
          res.writeHead(302, { location: '/' });
          return res.end();
        }
        const t = session.tenantId;
        if (req.method === 'GET') {
          if (path === '/app') {
            const [health, pending, cumulative, reports] = await Promise.all([
              dashStore.healthLatest(t), dashStore.pendingApprovals(t), dashStore.cumulative(t), dashStore.reports(t),
            ]);
            return html(res, 200, screens.homeScreen({ health, pending, cumulative, latestReportId: reports[0] && reports[0].id }));
          }
          if (path === '/app/approvals') return html(res, 200, screens.approvalsScreen({ pending: await dashStore.pendingApprovals(t) }));
          if (path === '/app/ledger') return html(res, 200, screens.ledgerScreen({ entries: await dashStore.ledger(t) }));
          if (path === '/app/reports') return html(res, 200, screens.reportsScreen({ reports: await dashStore.reports(t) }));
          if (path === '/app/settings') return html(res, 200, screens.settingsScreen({ settings: await dashStore.settings(t) }));
          if (path === '/app/confirm') return html(res, 200, screens.discoveryScreen(await dashStore.discovery(t)));
          if (path === '/app/plan') return html(res, 200, screens.planScreen({ plan: await dashStore.planOptions(t) }));
          if (path === '/app/first-fix') return html(res, 200, screens.firstFixScreen({ fix: await dashStore.firstFix(t) }));
          if (path === '/app/journey') return html(res, 200, screens.journeyScreen({ journey: await dashStore.journey(t) }));
        }
        if (req.method === 'POST') {
          const redirect = (loc) => { res.writeHead(302, { location: loc }); res.end(); };
          if (path.startsWith('/app/approve/')) { if (!(await planActive(dashStore, t))) return redirect('/app/plan'); await dashStore.approveChange(t, path.split('/')[3]); return redirect('/app/approvals'); }
          if (path.startsWith('/app/dismiss/')) { await dashStore.dismissChange(t, path.split('/')[3]); return redirect('/app/approvals'); }
          if (path.startsWith('/app/revert/')) { if (!(await planActive(dashStore, t))) return redirect('/app/plan'); await dashStore.requestRevert(t, path.split('/')[3]); return redirect('/app/ledger'); }
          if (path === '/app/confirm') { await confirmAndStart(t); return redirect('/app'); }
        }
        return json(res, 404, { error: 'not found' });
      }

      if (req.method === 'GET' && path.startsWith('/r/')) {
        // The web report by id. The store is async (it was never awaited, so
        // every /r/ link answered an empty page); a malformed id is a 404, not a 500.
        const id = path.slice(3);
        if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return html(res, 404, '<p style="font-family:sans-serif">Report not found.</p>');
        const rep = await Promise.resolve().then(() => store.getReportHtml(id)).catch(() => null);
        if (!rep || !rep.html_web) return html(res, 404, '<p style="font-family:sans-serif">Report not found.</p>');
        return html(res, 200, rep.html_web);
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: 'something went wrong on our side' });
    }
  });
}

module.exports = { createApp, LIMITS };
