// Authed Google API client per tenant — build-doc §6 token lifecycle.
// Loads the tenant's google_connection, refreshes the access token on demand
// (cached until expiry), and exposes an authed fetch. On invalid_grant the
// connection is marked expired (state machine) and the error surfaces so the
// §8 pipeline degrades honestly.
//
// NOTE on refresh-token storage: schema §1.1 earmarks Supabase Vault; until
// the vault wiring lands the column carries the token directly (service-role
// access only, RLS denies clients).

const { refreshAccessToken } = require('./oauth');
const { transition, classifyTokenError } = require('./connection-state');

function createGoogleAuth({ db, clientId, clientSecret, fetchImpl = fetch }) {
  const q = (s) => encodeURIComponent(s);
  const cache = new Map(); // tenantId -> { access_token, expires_at }

  async function connectionForTenant(tenantId) {
    // users → google_connections (one owner per tenant in v1).
    const user = await db.select('users', `tenant_id=eq.${q(tenantId)}&select=id&limit=1`, { single: true });
    if (!user) throw new Error(`no user for tenant ${tenantId}`);
    const conn = await db.select('google_connections', `user_id=eq.${q(user.id)}&select=*&limit=1`, { single: true });
    if (!conn) throw new Error(`no google connection for tenant ${tenantId}`);
    if (conn.status === 'revoked' || conn.status === 'expired') {
      throw new Error(`google connection ${conn.status} — reconnect needed`);
    }
    return conn;
  }

  async function accessToken(tenantId) {
    const cached = cache.get(tenantId);
    if (cached && cached.expires_at > Date.now() + 60_000) return cached.access_token;
    const conn = await connectionForTenant(tenantId);
    const r = await refreshAccessToken({ clientId, clientSecret, refreshToken: conn.refresh_token }, fetchImpl);
    if (r.error) {
      const event = classifyTokenError(r.error);
      if (event) {
        const t = transition(conn.status, event);
        if (t.changed) {
          await db.update('google_connections', `id=eq.${q(conn.id)}`, { status: t.status }).catch(() => {});
          await db.insert('ledger', [{
            tenant_id: tenantId, event: 'connection_changed', actor: 'system', summary_text: t.ledger.summary_text,
          }], { returning: false }).catch(() => {});
        }
      }
      throw new Error(`token refresh failed: ${JSON.stringify(r.error).slice(0, 200)}`);
    }
    cache.set(tenantId, r.tokens);
    await db.update('google_connections', `user_id=eq.${q(conn.user_id)}`, { last_validated_at: new Date().toISOString() }).catch(() => {});
    return r.tokens.access_token;
  }

  /** Authed JSON fetch. Throws { code } on API error classes for §7 handling. */
  async function api(tenantId, url, init = {}) {
    const token = await accessToken(tenantId);
    const res = await fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`google api ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`);
      err.code = body.error && body.error.status ? body.error.status : `HTTP_${res.status}`;
      throw err;
    }
    return body;
  }

  return { api, accessToken, connectionForTenant };
}

module.exports = { createGoogleAuth };
