// Pre-signin findings strip — build-doc §5.4, fix plan move 3.
// Turns a crawl result into the plain-language teaser shown before sign-in.
// Register: master §4 — no jargon, ever. "your tracking", not "container".
// Every line carries a tone: issue (worth fixing), ok (good), note (we saw
// this, here is what it means). Saying what we saw beats a false alarm.

const PROVIDER = { fresha: 'Fresha', calendly: 'Calendly', booksy: 'Booksy', opentable: 'OpenTable', shopify_checkout: 'Shopify checkout' };

function findingsStrip(crawl) {
  if (crawl.status !== 'complete') {
    return { headline: "We couldn't reach your website.", items: [], tones: [], visible_issue_count: 0 };
  }
  const t = crawl.tags_found || {};
  const seen = t.seen || {};
  const items = [];
  const tones = [];
  const add = (text, tone) => { items.push(text); tones.push(tone); };
  let issues = 0;
  const issue = (text) => { add(text, 'issue'); issues += 1; };

  if (seen.landing_page_host) {
    return { headline: 'That looks like a link page, not your website.', items: ['Paste your main website address and we will read that instead.'], tones: ['note'], visible_issue_count: 0, landing_page: true };
  }
  if (seen.maintenance) {
    return { headline: "Your site says it is not open yet.", items: ['It answered with a coming-soon page. When it is live, paste the address again.'], tones: ['note'], visible_issue_count: 0, maintenance: true };
  }

  const hasGtm = t.gtm_containers?.length > 0;
  const hasGa4 = t.ga4_ids?.length > 0;
  const consent = seen.consent_tool || null;

  if (hasGtm || hasGa4) add('Google tracking installed', 'ok');
  else issue('No Google tracking on your site. That is the first thing to fix, and we can do it with you in about thirty seconds.');

  if (t.legacy_ua?.length > 0) issue('Outdated tracking still running - it stopped collecting data in 2023');
  if (hasGa4 && t.ga4_ids.length > 1) issue('Two different tracking setups found - your numbers may be double-counted');
  if (hasGtm && t.gtm_containers.length > 1) issue('More than one tracking installation found');
  if (hasGtm && !hasGa4) {
    if (consent) add(`Waits for cookie consent (${consent}) before recording, which is right`, 'ok');
    else issue("Tracking is installed but we couldn't see it recording visits");
  }
  if (seen.server_side_gtm) add('You use server-side tagging. We read it through your analytics instead', 'note');
  if (seen.other_tools && seen.other_tools.length) add(`We can also see ${seen.other_tools.slice(0, 3).join(', ')}. We only check Google, and say what Google can and cannot see`, 'note');
  if (crawl.booking_provider && PROVIDER[crawl.booking_provider]) add(`Your bookings happen on ${PROVIDER[crawl.booking_provider]}, which we read through your analytics`, 'note');
  const wa = crawl.booking_provider === 'whatsapp' || (seen.contact && seen.contact.whatsapp);
  const phone = seen.contact && seen.contact.phone;
  if (wa && phone) add('Customers reach you on WhatsApp and by phone. Counting those is the one thing that matters, and we can set it up', 'note');
  else if (wa) add('Customers reach you on WhatsApp. Counting those messages is the one thing that matters, and we can set it up', 'note');
  else if (phone) add('Customers call you. Counting those calls is the one thing that matters, and we can set it up', 'note');

  const headline = issues > 0
    ? `${issues} thing${issues === 1 ? '' : 's'} worth fixing, visible from the outside`
    : 'Your tracking looks healthy from the outside - the full check looks inside';

  return { headline, items, tones, visible_issue_count: issues, no_tracking: !hasGtm && !hasGa4, pages_read: crawl.pages_crawled || null };
}

module.exports = { findingsStrip };
