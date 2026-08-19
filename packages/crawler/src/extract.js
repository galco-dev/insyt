// Extraction logic — pure functions over page HTML + network URLs.
// Kept free of Playwright so it unit-tests without a browser.

const PATTERNS = {
  gtm: /GTM-[A-Z0-9]{4,10}/g,
  ga4: /G-[A-Z0-9]{6,14}/g,
  ua: /UA-\d{4,10}-\d{1,4}/g,
  metaPixel: /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{5,20})['"]/g,
  awConversion: /AW-\d{6,12}/g,
};

const CMS_ASSET_HINTS = [
  ['shopify', /cdn\.shopify\.com|myshopify\.com/i],
  ['wordpress', /wp-content|wp-includes|wp-json/i],
  ['webflow', /website-files\.com|\bwebflow\b/i],
  ['wix', /wixstatic\.com|wix\.com\/website/i],
  ['squarespace', /squarespace-cdn\.com|squarespace\.com/i],
];

const BOOKING_PROVIDERS = [
  ['whatsapp', /wa\.me\/|api\.whatsapp\.com/i],
  ['fresha', /fresha\.com/i],
  ['calendly', /calendly\.com/i],
  ['shopify_checkout', /checkout\.shopify\.com|\/checkouts\//i],
  ['booksy', /booksy\.com/i],
  ['opentable', /opentable\./i],
];

const KEY_PAGE_HINTS = /contact|book|booking|appointment|services|shop|store|pricing|menu|reserve/i;

function uniq(matches) {
  return [...new Set(matches || [])];
}

/** Extract all tracking identifiers from a blob of HTML/JS text + captured request URLs. */
function extractTags(html, requestUrls = []) {
  const corpus = html + '\n' + requestUrls.join('\n');
  const pixelIds = [];
  let m;
  const pixelRe = new RegExp(PATTERNS.metaPixel.source, 'g');
  while ((m = pixelRe.exec(corpus)) !== null) pixelIds.push(m[1]);
  return {
    gtm_containers: uniq(corpus.match(PATTERNS.gtm)),
    ga4_ids: uniq(corpus.match(PATTERNS.ga4)),
    legacy_ua: uniq(corpus.match(PATTERNS.ua)),
    aw_conversion_ids: uniq(corpus.match(PATTERNS.awConversion)),
    meta_pixel_ids: uniq(pixelIds),
  };
}

/** CMS fingerprint order per build §5: generator meta → asset paths → headers. */
function fingerprintCms(html, headers = {}) {
  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (gen) {
    const g = gen[1].toLowerCase();
    if (g.includes('wordpress')) return 'wordpress';
    if (g.includes('webflow')) return 'webflow';
    if (g.includes('wix')) return 'wix';
    if (g.includes('squarespace')) return 'squarespace';
    if (g.includes('shopify')) return 'shopify';
  }
  for (const [name, re] of CMS_ASSET_HINTS) {
    if (re.test(html)) return name;
  }
  const powered = (headers['x-powered-by'] || '') + ' ' + (headers['server'] || '');
  if (/shopify/i.test(powered)) return 'shopify';
  if (/wix/i.test(powered)) return 'wix';
  return 'unsupported';
}

/** Booking / checkout provider links visible in the page. */
function detectBookingProvider(html) {
  for (const [name, re] of BOOKING_PROVIDERS) {
    if (re.test(html)) return name;
  }
  return null;
}

/** Derive up to `limit` key pages from nav links (contact, booking, services, shop…). */
function deriveKeyPages(html, baseUrl, limit = 5) {
  const hrefs = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>(.*?)<\/a>/gis)];
  const scored = [];
  const seen = new Set();
  for (const [, href, text] of hrefs) {
    let abs;
    try { abs = new URL(href, baseUrl); } catch { continue; }
    if (abs.origin !== new URL(baseUrl).origin) continue;
    const path = abs.pathname.replace(/\/$/, '');
    if (!path || path === '' || seen.has(path)) continue;
    const hay = path + ' ' + text.replace(/<[^>]+>/g, '');
    if (KEY_PAGE_HINTS.test(hay)) {
      seen.add(path);
      scored.push(abs.href);
    }
  }
  return scored.slice(0, limit);
}

module.exports = { extractTags, fingerprintCms, detectBookingProvider, deriveKeyPages, PATTERNS };
