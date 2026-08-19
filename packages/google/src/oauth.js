// Incremental-consent OAuth machinery — build-doc §6.
// Identity sign-in lives in Supabase Auth; THIS module handles the separate
// data-scope grants (ladder steps 2–4), token exchange/refresh/revoke.
// Transport is injectable so everything unit-tests offline.

const { LADDER } = require('./scopes');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';

/**
 * Build the consent URL for a ladder step.
 * include_granted_scopes=true makes consent incremental (previous grants
 * carry over); access_type=offline + prompt=consent guarantees a refresh
 * token on the step-2 grant.
 */
function buildAuthUrl({ clientId, redirectUri, step, state, loginHint }) {
  const scopes = LADDER[step];
  if (!scopes) throw new Error(`unknown ladder step: ${step}`);
  if (step === 'create') throw new Error('create step adds no scopes; do not send users to consent for it');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: step === 'discovery' ? 'consent' : 'select_account consent',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postForm(url, form, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Exchange an auth code. Returns { tokens, grantedScopes } on success or
 * { error } shaped for connection-state.classifyTokenError.
 */
async function exchangeCode({ clientId, clientSecret, redirectUri, code }, fetchImpl = fetch) {
  const { ok, body } = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code,
  }, fetchImpl);
  if (!ok) return { error: body };
  return {
    tokens: {
      access_token: body.access_token,
      refresh_token: body.refresh_token || null, // absent on re-consent of an existing grant
      expires_at: Date.now() + (body.expires_in || 0) * 1000,
    },
    grantedScopes: (body.scope || '').split(' ').filter(Boolean),
  };
}

/** Refresh an access token. { tokens, grantedScopes } | { error }. */
async function refreshAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  const { ok, body } = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, fetchImpl);
  if (!ok) return { error: body };
  return {
    tokens: {
      access_token: body.access_token,
      expires_at: Date.now() + (body.expires_in || 0) * 1000,
    },
    grantedScopes: (body.scope || '').split(' ').filter(Boolean),
  };
}

/**
 * Validation-sweep probe (§6 weekly proactive validation).
 * Refresh succeeds → { status:'valid', grantedScopes }.
 * invalid_grant → caller can't tell expiry from revocation here; tokeninfo on
 * the (dead) access token distinguishes nothing, so the sweep reports
 * 'refresh_failed' and the reconnect flow covers both.
 */
async function validateConnection(conn, creds, fetchImpl = fetch) {
  const r = await refreshAccessToken({ ...creds, refreshToken: conn.refreshToken }, fetchImpl);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, grantedScopes: r.grantedScopes };
}

/** Revoke a token (user-initiated disconnect in Settings). Best-effort. */
async function revokeToken(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  return res.ok;
}

module.exports = {
  AUTH_ENDPOINT, TOKEN_ENDPOINT, REVOKE_ENDPOINT, TOKENINFO_ENDPOINT,
  buildAuthUrl, exchangeCode, refreshAccessToken, validateConnection, revokeToken,
};
