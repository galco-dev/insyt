// Store what discovery found (fix plan move 10): shared by the sign-in
// callback and by re-discovery, so an account that appears later is seen.
const { matchAssets } = require('./match');

const q = (s) => encodeURIComponent(s);

/** The site's latest crawl tags and hostname, for matching. */
async function crawlTagsForTenant(db, tenantId) {
  const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true });
  if (!t || !t.website_url) return { tags: null, domain: null };
  let domain;
  try { domain = new URL(t.website_url.startsWith('http') ? t.website_url : `https://${t.website_url}`).hostname; } catch { return { tags: null, domain: null }; }
  const c = await db.select('crawls', `url=ilike.*${q(domain)}*&select=tags_found&order=created_at.desc&limit=1`, { single: true });
  return { tags: (c && c.tags_found) || null, domain };
}

/** Store discovered assets and mark crawl-matched ones linked. */
async function storeDiscoveredAssets({ db, tenantId, assets, tagsFound, domain = null }) {
  const { matched, unmatched, confidence } = (tagsFound || domain)
    ? matchAssets(tagsFound || {}, assets, { domain })
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
  return { inserted: fresh.length, matched: matched.length, confidence, fresh_unmatched: fresh.filter((r) => !r.linked).map((r) => ({ kind: r.kind, external_id: r.external_id, display_name: r.display_name })) };
}

/**
 * Look again (fix plan move 10): enumerate what the tenant's Google login
 * can see today and store anything new. Runs weekly from the sweep and on
 * demand from Settings. Never unlinks anything.
 */
async function rediscoverTenant({ db, auth, developerToken, loginCustomerId, tenantId, listClients = null, discover = null, now = Date.now }) {
  const { createListClients } = require('./list-clients');
  const { discoverAssets } = require('./discovery');
  const accessToken = await auth.accessToken(tenantId);
  const clients = (listClients || createListClients)({ accessToken, developerToken, loginCustomerId });
  const { assets, errors } = await (discover || discoverAssets)(clients);
  const { tags, domain } = await crawlTagsForTenant(db, tenantId);
  const result = await storeDiscoveredAssets({ db, tenantId, assets, tagsFound: tags, domain });
  await db.insert('audit_log', [{ tenant_id: tenantId, event: 'rediscovered', detail: { inserted: result.inserted, matched: result.matched, errors: errors.length, at: new Date(now()).toISOString() } }], { returning: false }).catch(() => {});
  return { ...result, errors };
}

module.exports = { storeDiscoveredAssets, crawlTagsForTenant, rediscoverTenant };
