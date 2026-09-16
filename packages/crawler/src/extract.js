// Extraction logic - pure functions over page HTML + network URLs.
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

/**
 * Price-menu extraction - feeds truth.price_mismatch (deep layer). Pulls
 * "label ... CUR amount" pairs from visible text; deterministic, no model.
 * Strips tags first; a label is the preceding run of letters/spaces on the
 * same text fragment (menus, price lists, service cards all match).
 */
function extractPrices(html, { currencies = ['AED', 'USD', 'EUR', 'GBP', '\\$'] } = {}) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const cur = currencies.join('|');
  const re = new RegExp(`([A-Za-z][A-Za-z&' -]{2,60}?)[\\s:·.-]*(?:from\\s+)?(${cur})\\s?(\\d{2,5})(?!\\d)`, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].trim().replace(/\s+/g, ' ');
    const amount = Number(m[3]);
    const key = `${label.toLowerCase()}::${amount}`;
    if (label.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, amount, currency: m[2] === '$' ? 'USD' : m[2] });
  }
  return out;
}

// What else the page tells us (fix plan move 3): the consent tool that holds
// tags until a click, the other tools in play, how customers reach the
// business, server-side tagging, a site that is not really up, and a
// link-in-bio host that is not the real website. Named on the strip and in
// the app instead of read as faults.
const CONSENT_TOOLS = [
  ['Cookiebot', /cookiebot\.com|Cookiebot/],
  ['OneTrust', /onetrust\.com|optanon/i],
  ['Usercentrics', /usercentrics\.eu|usercentrics/i],
  ['CookieYes', /cookieyes\.com|cookie-law-info/i],
  ['iubenda', /iubenda\.com/i],
  ['Termly', /termly\.io/i],
  ['Complianz', /complianz/i],
  ['Google consent mode', /gtag\s*\(\s*['"]consent['"]/],
];
const OTHER_TOOLS = [
  ['Meta', /connect\.facebook\.net|fbq\s*\(/],
  ['HubSpot', /js\.hs-scripts\.com|hs-analytics/],
  ['Segment', /cdn\.segment\.com|analytics\.load\(/],
  ['Matomo', /matomo\.js|piwik\.js/],
  ['Hotjar', /static\.hotjar\.com/],
  ['TikTok', /analytics\.tiktok\.com/],
  ['LinkedIn', /snap\.licdn\.com/],
  ['Klaviyo', /static\.klaviyo\.com/],
  ['Clarity', /clarity\.ms/],
];
const LANDING_HOSTS = /(^|\.)(linktr\.ee|linktree\.com|wixsite\.com|carrd\.co|bio\.site|beacons\.ai|taplink\.cc|lnk\.bio|milkshake\.app)$/i;

function detectSiteSignals(html = '', requestUrls = [], hostname = '') {
  const h = String(html || '');
  const consent = (CONSENT_TOOLS.find(([, re]) => re.test(h)) || [null])[0];
  const other = OTHER_TOOLS.filter(([, re]) => re.test(h)).map(([name]) => name);
  const head = h.slice(0, 20_000);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [, ''])[1];
  const maintenance = /coming soon|under construction|maintenance mode|site is being updated|we'll be back/i.test(`${title} ${head.replace(/<[^>]+>/g, ' ').slice(0, 4000)}`) && h.length < 60_000;
  const host = String(hostname || '').toLowerCase();
  let serverSide = false;
  if (host) {
    const site = host.replace(/^www\./, '');
    for (const u of requestUrls || []) {
      try {
        const x = new URL(u);
        const own = x.hostname === site || x.hostname.endsWith(`.${site}`);
        if (own && /\/gtm\.js|\/g\/collect|\/gtag\/js/.test(x.pathname + x.search)) { serverSide = true; break; }
      } catch { /* not a url */ }
    }
  }
  return {
    consent_tool: consent,
    other_tools: other,
    contact: {
      whatsapp: /wa\.me\/|api\.whatsapp\.com/i.test(h),
      phone: /href=["']tel:/i.test(h),
    },
    server_side_gtm: serverSide,
    maintenance,
    landing_page_host: LANDING_HOSTS.test(host),
  };
}

module.exports = { extractTags, fingerprintCms, detectBookingProvider, deriveKeyPages, extractPrices, detectSiteSignals, PATTERNS };
