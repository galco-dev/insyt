// Crawl ↔ discovered-assets cross-match - build-doc §7.
// Container IDs and G-IDs seen on the site score the "this is your site"
// confidence per asset. Output drives the confirmation screen: matched
// assets pre-ticked, unmatched listed collapsed. Never a configuration form.

/**
 * @param {object} tagsFound  crawls.tags_found ({ gtm_containers, ga4_ids, legacy_ua, aw_conversion_ids })
 * @param {Array}  assets     discoverAssets() output rows
 * @returns {{ matched: [], unmatched: [], confidence: number }}
 *   confidence 0–1 for "the signed-in Google account owns this site".
 */
function matchAssets(tagsFound, assets, { domain = null } = {}) {
  const onSite = {
    gtm: new Set(tagsFound.gtm_containers || []),
    ga4: new Set(tagsFound.ga4_ids || []),
    aw: new Set((tagsFound.aw_conversion_ids || []).map((id) => id.replace(/^AW-/, ''))),
  };

  const matched = [];
  const unmatched = [];

  for (const a of assets) {
    let hit = false;
    let via = null;
    if (a.kind === 'gtm_container' && onSite.gtm.has(a.external_id)) { hit = true; via = 'container_on_site'; }
    if (a.kind === 'ga4_stream' && onSite.ga4.has(a.external_id)) { hit = true; via = 'g_id_on_site'; }
    if (a.kind === 'ads_account' && onSite.aw.has(String(a.external_id).replace(/-/g, ''))) { hit = true; via = 'aw_tag_on_site'; }
    (hit ? matched : unmatched).push({ ...a, matched: hit, matched_via: via });
  }

  // GA4 property matches transitively through a matched stream.
  const matchedPropIds = new Set(
    matched.filter((a) => a.kind === 'ga4_stream').map((a) => a.metadata.property_id),
  );
  for (let i = unmatched.length - 1; i >= 0; i--) {
    const a = unmatched[i];
    if (a.kind === 'ga4_property' && matchedPropIds.has(a.external_id)) {
      unmatched.splice(i, 1);
      matched.push({ ...a, matched: true, matched_via: 'stream_match' });
    }
  }

  // Ads accounts the modern way (fix plan move 2): the account a matched
  // GA4 property is linked to, or one whose ads point at this site. The
  // AW tag on the page still counts; most accounts no longer carry one.
  const linkedIds = new Set(matched.filter((a) => a.kind === 'ga4_property').flatMap((a) => (a.metadata && a.metadata.ads_links) || []).map((id) => String(id).replace(/-/g, '')));
  const site = domain ? String(domain).replace(/^www\./, '').toLowerCase() : null;
  for (let i = unmatched.length - 1; i >= 0; i--) {
    const a = unmatched[i];
    if (a.kind !== 'ads_account') continue;
    const id = String(a.external_id).replace(/-/g, '');
    const domains = ((a.metadata && a.metadata.domains) || []).map((d) => String(d).replace(/^www\./, '').toLowerCase());
    let via = null;
    if (linkedIds.has(id)) via = 'ga4_link';
    else if (site && domains.some((d) => d === site || d.endsWith(`.${site}`) || site.endsWith(`.${d}`))) via = 'final_url_domain';
    if (via) { unmatched.splice(i, 1); matched.push({ ...a, matched: true, matched_via: via }); }
  }

  // Confidence: strongest single signal wins; independent signals compound.
  const signals = new Set(matched.map((m) => m.matched_via));
  let confidence = 0;
  if (signals.has('container_on_site')) confidence = Math.max(confidence, 0.9);
  if (signals.has('g_id_on_site')) confidence = Math.max(confidence, 0.85);
  if (signals.has('aw_tag_on_site')) confidence = Math.max(confidence, 0.7);
  if (signals.has('ga4_link')) confidence = Math.max(confidence, 0.85);
  if (signals.has('final_url_domain')) confidence = Math.max(confidence, 0.75);
  if (signals.size >= 2) confidence = Math.min(1, confidence + 0.1);

  return { matched, unmatched, confidence };
}

module.exports = { matchAssets };
