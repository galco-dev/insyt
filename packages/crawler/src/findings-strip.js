// Pre-signin findings strip — build-doc §5.4.
// Turns a crawl result into the plain-language teaser shown before sign-in.
// Register: master §4 — no jargon, ever. "your tracking", not "container".

function findingsStrip(crawl) {
  if (crawl.status !== 'complete') {
    return { headline: "We couldn't reach your website.", items: [], visible_issue_count: 0 };
  }
  const t = crawl.tags_found;
  const items = [];
  let issues = 0;

  const hasGtm = t.gtm_containers?.length > 0;
  const hasGa4 = t.ga4_ids?.length > 0;

  if (hasGtm || hasGa4) items.push('Google tracking installed');
  else { items.push('No Google tracking found on your site'); issues += 1; }

  if (t.legacy_ua?.length > 0) { items.push('Outdated tracking still running — it stopped collecting data in 2023'); issues += 1; }
  if (hasGa4 && t.ga4_ids.length > 1) { items.push('Two different tracking setups found — your numbers may be double-counted'); issues += 1; }
  if (hasGtm && t.gtm_containers.length > 1) { items.push('More than one tracking installation found'); issues += 1; }
  if (hasGtm && !hasGa4) { items.push("Tracking is installed but we couldn't see it recording visits"); issues += 1; }
  if (crawl.booking_provider === 'whatsapp') items.push('Customers contact you on WhatsApp — those enquiries are usually invisible to Google');

  const headline = issues > 0
    ? `Found: ${items[0]}, ${issues} issue${issues === 1 ? '' : 's'} visible from the outside`
    : 'Found: Google tracking installed — the full check looks inside';

  return { headline, items, visible_issue_count: issues };
}

module.exports = { findingsStrip };
