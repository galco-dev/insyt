// Minimal signed-cookie session: HMAC(tenant_id.expiry) with SESSION_SECRET.
// Set at magic-link redemption; Supabase Auth (Google) replaces/augments this
// for full sign-in — the cookie is how one-tap email links stay one-tap.

const crypto = require('crypto');

const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function issueSession({ tenantId, secret, now, ttlMs = 30 * 86_400_000 }) {
  const payload = `${tenantId}.${now + ttlMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

function readSession(cookieHeader, secret, now) {
  const raw = (cookieHeader || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('insyt_s='));
  if (!raw) return null;
  const value = raw.slice('insyt_s='.length);
  const i = value.lastIndexOf('.');
  const payload = value.slice(0, i);
  const mac = value.slice(i + 1);
  if (!payload || sign(payload, secret) !== mac) return null;
  const [tenantId, expiry] = payload.split('.');
  if (Number(expiry) < now) return null;
  return { tenantId };
}

const cookieFor = (session) => `insyt_s=${session}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`;

module.exports = { issueSession, readSession, cookieFor };
