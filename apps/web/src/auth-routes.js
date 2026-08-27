// Google data-scope OAuth routes — build-doc §6 ladder steps 2–4 + §7
// discovery-on-callback. Identity sign-in stays with Supabase Auth; these
// routes handle the SEPARATE data grants and the moment right after:
//
//   GET /auth/google/start?step=discovery|write|create
//     session required → 302 to Google's consent screen (incremental).
//   GET /auth/google/callback?code&state
//     verify state → exchange code → upsert google_connections →
//     (discovery step) enumerate assets, match vs latest crawl, store →
//     302 /app/confirm (discovery) or /app (later steps).
//
// Everything injected for tests: deps = { db, oauth, discover, listClients,
// match, config: { clientId, clientSecret, redirectUri, developerToken,
// loginCustomerId }, sessionSecret, now }.

const crypto = require('crypto');
const { buildAuthUrl, exchangeCode } = require('../../../packages/google/src/oauth');
const { discoverAssets } = require('../../../packages/google/src/discovery');
const { createListClients } = require('../../../packages/google/src/list-clients');
const { matchAssets } = require('../../../packages/google/src/match');
const { scopeLevel } = require('../../../packages/google/src/scopes');

const q = (s) => encodeURIComponent(s);
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

// State: signed tenant + step + expiry — CSRF guard that also survives the
// round-trip without server-side storage.
function issueState({ tenantId, step, secret, now, site = '' }) {
  const payload = `${tenantId || ''}|${step}|${now + 15 * 60_000}|${site}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload, secret)}`;
}
function readState(state, secret, now) {
  const i = (state || '').lastIndexOf('.');
  if (i < 0) return null;
  const payload = Buffer.from(state.slice(0, i), 'base64url').toString();
  if (sign(payload, secret) !== state.slice(i + 1)) return null;
  const [tenantId, step, expiry, site = ''] = payload.split('|');
  if (Number(expiry) < now) return null;
  return { tenantId, step, site };
}

/** Store discovered assets and mark crawl-matched ones linked. */
async function storeDiscoveredAssets({ db, tenantId, assets, tagsFound }) {
  const { matched, unmatched, confidence } = tagsFound
    ? matchAssets(tagsFound, assets)
    : { matched: [], unmatched: assets.map((a) => ({ ...a, matched: false })), confidence: 0 };
  const rows = [...matched, ...unmatched].map((a) => ({
    tenant_id: tenantId,
    kind: a.kind,
    external_id: a.external_id,
    display_name: a.display_name,
    currency: a.currency,
    linked: !!a.matched,
    metadata: { ...a.metadata, matched_via: a.matched_via || null },
  }));
  const existing = await db.select('assets', `tenant_id=eq.${q(tenantId)}&select=kind,external_id,linked`);
  const have = new Set(existing.map((e) => `${e.kind}:${e.external_id}`));
  const fresh = rows.filter((r) => !have.has(`${r.kind}:${r.external_id}`));
  if (fresh.length) await db.insert('assets', fresh, { returning: false });
  // Upgrade linked on rows that now match the site.
  for (const r of rows.filter((x) => x.linked && have.has(`${x.kind}:${x.external_id}`))) {
    await db.update('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.${r.kind}&external_id=eq.${q(r.external_id)}`, { linked: true }).catch(() => {});
  }
  return { inserted: fresh.length, matched: matched.length, confidence };
}

async function fetchUserinfo(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function latestCrawlTags(db, tenantId) {
  const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true });
  if (!t || !t.website_url) return null;
  let domain;
  try { domain = new URL(t.website_url.startsWith('http') ? t.website_url : `https://${t.website_url}`).hostname; } catch { return null; }
  const c = await db.select('crawls', `url=ilike.*${q(domain)}*&select=tags_found&order=created_at.desc&limit=1`, { single: true });
  return (c && c.tags_found) || null;
}

/**
 * Mount-point handler. Returns true when the request was handled.
 * session: { tenantId } | null (from the signed cookie).
 */
async function handleGoogleAuth(req, res, u, session, deps) {
  const path = u.pathname;
  const { db, config, sessionSecret, now = Date.now } = deps;
  const redirect = (loc) => { res.writeHead(302, { location: loc }); res.end(); return true; };
  const fail = (msg) => {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<p style="font-family:sans-serif">${msg}</p>`);
    return true;
  };

  if (req.method === 'GET' && path === '/auth/google/start') {
    const step = ['discovery', 'write', 'create'].includes(u.searchParams.get('step')) ? u.searchParams.get('step') : 'discovery';
    // Signed-out visitors may start discovery: that consent doubles as the
    // sign-in (identity scopes ride along) and the callback creates the
    // account. Later steps need an existing session.
    if (!session && step !== 'discovery') return redirect('/');
    if (step === 'create') return redirect('/app'); // create adds no scopes (§6)
    const site = (u.searchParams.get('site') || '').replace(/[|\s]/g, '').slice(0, 200);
    const state = issueState({ tenantId: session ? session.tenantId : '', step, secret: sessionSecret, now: now(), site });
    return redirect(buildAuthUrl({ clientId: config.clientId, redirectUri: config.redirectUri, step, state }));
  }

  if (req.method === 'GET' && path === '/auth/google/callback') {
    // Declined consent: a signed-in user lands on the dashboard with a note; a
    // signed-out visitor goes back to the start page (not a sign-in loop).
    if (u.searchParams.get('error')) return redirect(session ? '/app?connect=declined' : '/app/start?declined=1');
    const st = readState(u.searchParams.get('state'), sessionSecret, now());
    if (!st) return fail('This connection link expired — start again from your dashboard.');
    const code = u.searchParams.get('code');
    if (!code) return fail('Missing sign-in code.');

    const ex = await (deps.exchangeCode || exchangeCode)({
      clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, code,
    });
    if (ex.error) return fail('Google did not accept that connection — try again.');

    // Signed-out start: who is this? Ask Google, find-or-create the tenant,
    // remember the site they checked, and set the session cookie on the way out.
    let setCookie = null;
    if (!st.tenantId) {
      const who = await (deps.fetchUserinfo || fetchUserinfo)(ex.tokens.access_token);
      if (!who || !who.sub) return fail('Google did not tell us who you are — try again.');
      if (!deps.findOrCreateTenantByGoogle || !deps.issueSession || !deps.cookieFor) return fail('Sign-in is not available right now.');
      st.tenantId = await deps.findOrCreateTenantByGoogle({ sub: who.sub, email: who.email, name: who.name });
      if (st.site) {
        const t = await db.select('tenants', `id=eq.${q(st.tenantId)}&select=website_url`, { single: true }).catch(() => null);
        if (t && !t.website_url) await db.update('tenants', `id=eq.${q(st.tenantId)}`, { website_url: st.site }).catch(() => {});
      }
      setCookie = deps.cookieFor(deps.issueSession({ tenantId: st.tenantId, secret: sessionSecret, now: now() }));
    }
    const redirectWithSession = (loc) => {
      res.writeHead(302, setCookie ? { location: loc, 'set-cookie': setCookie } : { location: loc });
      res.end();
      return true;
    };

    // Upsert the connection on the tenant's owner user.
    const user = await db.select('users', `tenant_id=eq.${q(st.tenantId)}&select=id&limit=1`, { single: true });
    if (!user) return fail('No account found for this session.');
    const level = scopeLevel(ex.grantedScopes);
    const conn = await db.select('google_connections', `user_id=eq.${q(user.id)}&select=id,refresh_token,granted_scopes&limit=1`, { single: true });
    const patch = {
      granted_scopes: ex.grantedScopes,
      scope_level: level || 'readonly',
      status: level ? 'valid' : 'partial',
      last_validated_at: new Date(now()).toISOString(),
    };
    if (ex.tokens.refresh_token) patch.refresh_token = ex.tokens.refresh_token;
    if (conn) await db.update('google_connections', `id=eq.${q(conn.id)}`, patch);
    else await db.insert('google_connections', [{ user_id: user.id, ...patch }], { returning: false });
    await db.insert('ledger', [{
      tenant_id: st.tenantId, event: 'connection_changed', actor: 'user',
      summary_text: st.step === 'discovery' ? 'Google connected — read access granted.' : 'Google connection upgraded — fix access granted.',
    }], { returning: false }).catch(() => {});

    // Discovery step: enumerate + match + store, then confirmation screen.
    if (st.step === 'discovery') {
      const clients = (deps.listClients || createListClients)({
        accessToken: ex.tokens.access_token,
        developerToken: config.developerToken,
        loginCustomerId: config.loginCustomerId,
      });
      const { assets, errors } = await (deps.discoverAssets || discoverAssets)(clients);
      const tagsFound = await latestCrawlTags(db, st.tenantId);
      const result = await storeDiscoveredAssets({ db, tenantId: st.tenantId, assets, tagsFound });
      if (errors.length) {
        await db.insert('audit_log', [{
          tenant_id: st.tenantId, event: 'discovery_partial', detail: { errors },
        }], { returning: false }).catch(() => {});
      }
      return redirectWithSession(`/app/confirm?found=${assets.length}&matched=${result.matched}`);
    }
    return redirectWithSession('/app');
  }

  return false;
}

module.exports = { handleGoogleAuth, issueState, readState, storeDiscoveredAssets };
