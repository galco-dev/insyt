// app.tryinsyt.com — Journey A server slice (build-doc §11 screens 1, 3, 4).
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
//   crawler: { discoveryCrawl(url) }  — real one on Railway; stub in tests
//   now: () => ms epoch

const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const { findingsStrip } = require('../../../packages/crawler/src/findings-strip');
const { redeemLink } = require('../../../packages/emails/src/magic-links');
const { landingPage, progressPage } = require('./pages');
const { handleOps } = require('./ops');
const { issueSession, readSession, cookieFor } = require('./session');
const { handleGoogleAuth } = require('./auth-routes');
const screens = require('./screens');

// §5 limits: 1 crawl/domain/hour, 3/day (email-verified: 5 — later).
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

function createApp({ store, crawler, now = Date.now, dashStore = null, opsStore = null, queue = null, opsToken = null, sessionSecret = 'dev-secret', billing = null, authBridge = null, googleAuth = null, checkout = null, clientDir = null }) {
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
  async function handleCrawlRequest(res, urlRaw) {
    let target;
    try { target = new URL(urlRaw.startsWith('http') ? urlRaw : `https://${urlRaw}`); } catch {
      return json(res, 400, { error: 'That does not look like a website address.' });
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(target.hostname)) {
      return json(res, 400, { error: 'That does not look like a website address.' });
    }
    const domain = target.hostname;
    if (await store.crawlCountForDomain(domain, now() - 3_600_000) >= LIMITS.perHour
      || await store.crawlCountForDomain(domain, now() - 86_400_000) >= LIMITS.perDay) {
      return json(res, 429, { error: 'This site was checked very recently — try again in a little while.' });
    }
    const id = await store.createCrawl({ url: target.href, domain, status: 'running', created_at: now() });
    // Fire and record; progress endpoint reflects state.
    crawler.discoveryCrawl(target.href)
      .then((result) => store.patchCrawl(id, { status: result.status, result, strip: findingsStrip(result) }))
      .catch((err) => store.patchCrawl(id, { status: 'failed', error: String(err.message || err) }));
    return json(res, 202, { id });
  }

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;

    try {
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/') return html(res, 200, landingPage());

      // Stripe webhooks — §10. Signature verified before anything is parsed.
      if (req.method === 'POST' && path === '/api/stripe/webhook' && billing) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        await new Promise((r) => req.on('end', r));
        const sig = req.headers['stripe-signature'] || '';
        const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
        const expected = require('crypto').createHmac('sha256', billing.webhookSecret)
          .update(`${parts.t}.${raw}`).digest('hex');
        if (!parts.v1 || parts.v1 !== expected) return json(res, 400, { error: 'bad signature' });
        const result = await billing.handleWebhook(JSON.parse(raw), billing.store);
        return json(res, 200, { received: true, handled: result.handled });
      }

      if (req.method === 'POST' && path === '/api/crawl') {
        let body = '';
        req.on('data', (c) => { body += c; });
        await new Promise((r) => req.on('end', r));
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
        if (!parsed.url) return json(res, 400, { error: 'url required' });
        return handleCrawlRequest(res, parsed.url);
      }

      if (req.method === 'GET' && path.startsWith('/api/crawl/')) {
        const c = await store.getCrawl(path.split('/')[3]);
        if (!c) return json(res, 404, { error: 'unknown crawl' });
        return json(res, 200, { status: c.status, strip: c.strip || null });
      }

      if (req.method === 'GET' && path.startsWith('/check/')) {
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
        const handled = await handleGoogleAuth(req, res, u, session, { ...googleAuth, sessionSecret, now });
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
            const r = await checkout.audit({ tenantId: session.tenantId, kind: parsed.kind || 'audit_unlock' });
            return json(res, 200, { url: r.url });
          }
          if (path === '/api/checkout/subscribe') {
            if (!parsed.tier) return json(res, 400, { error: 'tier required' });
            const r = await checkout.subscribe({ tenantId: session.tenantId, tier: parsed.tier, cadence: parsed.cadence || 'monthly' });
            return json(res, 200, { url: r.url });
          }
          if (path === '/api/checkout/portal') {
            const r = await checkout.portal({ tenantId: session.tenantId });
            return json(res, 200, { url: r.url });
          }
        } catch (err) {
          return json(res, 400, { error: 'We could not start that payment — try again in a moment.' });
        }
      }

      // Report-stream List-Unsubscribe target (§17).
      if (req.method === 'GET' && path === '/m/unsubscribe') {
        return html(res, 200, '<p style="font-family:sans-serif">You are unsubscribed from weekly report emails. Alerts about breakage still reach you — those protect your money. Manage everything in Settings.</p>');
      }

      // Magic-link redemption: single-use, purpose-routed (§12).
      if (req.method === 'GET' && path.startsWith('/m/')) {
        const token = path.slice(3);
        const r = redeemLink(token, now(), store.magicLinks);
        if (!r.ok) {
          const msg = r.reason === 'expired' ? 'This link has expired — request a fresh one from your latest email.'
            : r.reason === 'used' ? 'This link was already used. Open your dashboard instead.'
              : 'This link is not valid.';
          return html(res, 410, `<p style="font-family:sans-serif">${msg}</p>`);
        }
        // Redemption signs the tenant in (one tap from inbox — master §5).
        const session = issueSession({ tenantId: r.link.tenant_id, secret: sessionSecret, now: now() });
        const dest = {
          view_report: `/r/${r.link.target_id}`,
          approve_all: '/app/approvals',
          approve_one: '/app/approvals',
          revert: `/app/revert/${r.link.target_id}`,
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
        if (req.method === 'GET') {
          if (sub === '/home') {
            const [health, pending, cumulative, reports, streak, plan] = await Promise.all([
              dashStore.healthLatest(t), dashStore.pendingApprovals(t), dashStore.cumulative(t), dashStore.reports(t),
              dashStore.approvalStreak ? dashStore.approvalStreak(t) : 0,
              dashStore.planPosition ? dashStore.planPosition(t) : null,
            ]);
            return json(res, 200, { health, pending, cumulative, reports, streak, plan });
          }
          if (sub === '/approvals') return json(res, 200, { pending: await dashStore.pendingApprovals(t) });
          if (sub === '/ledger') return json(res, 200, { entries: await dashStore.ledger(t) });
          if (sub === '/reports') return json(res, 200, { reports: await dashStore.reports(t) });
          if (sub === '/settings') return json(res, 200, { settings: await dashStore.settings(t) });
          if (sub === '/discovery') return json(res, 200, await dashStore.discovery(t));
          if (sub === '/plan') return json(res, 200, { plan: await dashStore.planOptions(t) });
          if (sub === '/first-fix') return json(res, 200, { fix: await dashStore.firstFix(t) });
          if (sub === '/journey') return json(res, 200, { journey: await dashStore.journey(t) });
          if (sub.startsWith('/report/')) {
            const r = await dashStore.reportData(t, sub.split('/')[2]);
            if (!r) return json(res, 404, { error: 'Report not found.' });
            return json(res, 200, { report: r });
          }
        }
        if (req.method === 'POST') {
          if (sub.startsWith('/approve/')) { await dashStore.approveChange(t, sub.split('/')[2]); return json(res, 200, { ok: true }); }
          if (sub.startsWith('/dismiss/')) { await dashStore.dismissChange(t, sub.split('/')[2]); return json(res, 200, { ok: true }); }
          if (sub.startsWith('/revert/')) { await dashStore.requestRevert(t, sub.split('/')[2]); return json(res, 200, { ok: true }); }
          if (sub === '/confirm') { await dashStore.confirmAssets(t); return json(res, 200, { ok: true }); }
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- ops console (internal)
      if (path.startsWith('/ops') && opsStore) {
        const handled = await handleOps(req, res, u, { opsStore, queue, opsToken });
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
          if (path.startsWith('/app/approve/')) { await dashStore.approveChange(t, path.split('/')[3]); return redirect('/app/approvals'); }
          if (path.startsWith('/app/dismiss/')) { await dashStore.dismissChange(t, path.split('/')[3]); return redirect('/app/approvals'); }
          if (path.startsWith('/app/revert/')) { await dashStore.requestRevert(t, path.split('/')[3]); return redirect('/app/ledger'); }
          if (path === '/app/confirm') { await dashStore.confirmAssets(t); return redirect('/app'); }
        }
        return json(res, 404, { error: 'not found' });
      }

      if (req.method === 'GET' && path.startsWith('/r/')) {
        const rep = store.getReportHtml(path.slice(3));
        if (!rep) return html(res, 404, '<p style="font-family:sans-serif">Report not found.</p>');
        return html(res, 200, rep.html_web);
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: 'something went wrong on our side' });
    }
  });
}

module.exports = { createApp, LIMITS };
