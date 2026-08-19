// Magic-link machinery — build-doc §12: single-use, scoped, expiring.
// Report/other links live 72h; approve links 7d. Tokens are random 256-bit,
// only their SHA-256 hash is stored (magic_links.token_hash).
//
// store (injected):
//   insertLink(row), findByHash(hash) -> row | null, markUsed(id, atIso)

const crypto = require('crypto');

const TTL_HOURS = {
  approve_all: 168, approve_one: 168, // 7 days
  view_report: 72, revert: 72, reconnect: 72, resume_journey: 72,
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Mint a link. Returns { token, url } — the token itself is never stored. */
function mintLink({ tenantId, purpose, targetId = null, baseUrl, now }, store) {
  if (!(purpose in TTL_HOURS)) throw new Error(`unknown magic-link purpose: ${purpose}`);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(now + TTL_HOURS[purpose] * 3600 * 1000).toISOString();
  store.insertLink({
    tenant_id: tenantId, purpose, target_id: targetId,
    token_hash: sha256(token), expires_at: expires, used_at: null,
  });
  return { token, url: `${baseUrl}/m/${token}`, expires_at: expires };
}

/**
 * Redeem a token. Single-use enforced here: a second redemption fails even
 * inside the expiry window. Returns { ok, link } | { ok:false, reason }.
 */
function redeemLink(token, now, store) {
  const row = store.findByHash(sha256(token));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (Date.parse(row.expires_at) < now) return { ok: false, reason: 'expired' };
  store.markUsed(row.id, new Date(now).toISOString());
  return { ok: true, link: row };
}

module.exports = { mintLink, redeemLink, TTL_HOURS, sha256 };
