// Unit tests for the extraction layer — no browser needed.
const assert = require('node:assert');
const { test } = require('node:test');
const {
  extractTags, fingerprintCms, detectBookingProvider, deriveKeyPages,
} = require('../src/extract');

test('extracts GTM, GA4, UA and AW ids', () => {
  const html = `
    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>
    <script>gtag('config', 'G-XYZ789ABCD'); gtag('config','AW-123456789');</script>
    <script>ga('create', 'UA-12345678-1', 'auto');</script>`;
  const t = extractTags(html);
  assert.deepStrictEqual(t.gtm_containers, ['GTM-ABC123']);
  assert.deepStrictEqual(t.ga4_ids, ['G-XYZ789ABCD']);
  assert.deepStrictEqual(t.legacy_ua, ['UA-12345678-1']);
  assert.deepStrictEqual(t.aw_conversion_ids, ['AW-123456789']);
});

test('extracts meta pixel init id', () => {
  const html = `<script>fbq('init', '1234567890123');fbq('track','PageView');</script>`;
  assert.deepStrictEqual(extractTags(html).meta_pixel_ids, ['1234567890123']);
});

test('dedupes ids found in html and network urls', () => {
  const t = extractTags('<script>GTM-DUP111</script>', ['https://www.googletagmanager.com/gtm.js?id=GTM-DUP111']);
  assert.deepStrictEqual(t.gtm_containers, ['GTM-DUP111']);
});

test('cms fingerprint: generator meta wins', () => {
  const html = `<meta name="generator" content="WordPress 6.4"><img src="https://cdn.shopify.com/x.png">`;
  assert.strictEqual(fingerprintCms(html), 'wordpress');
});

test('cms fingerprint: asset paths', () => {
  assert.strictEqual(fingerprintCms('<img src="https://assets.website-files.com/x/y.png">'), 'webflow');
  assert.strictEqual(fingerprintCms('<link href="/wp-content/themes/x.css">'), 'wordpress');
  assert.strictEqual(fingerprintCms('<img src="https://static.wixstatic.com/a.png">'), 'wix');
  assert.strictEqual(fingerprintCms('<div>plain html</div>'), 'unsupported');
});

test('site signals (fix plan move 3): consent tool, other tools, contact, server-side tagging, maintenance, link pages', () => {
  const { detectSiteSignals } = require('../src/extract');
  const html = `<html><head><title>Glow Studio</title><script src="https://consent.cookiebot.com/uc.js"></script>
    <script src="https://connect.facebook.net/en_US/fbevents.js"></script><script src="https://js.hs-scripts.com/1.js"></script></head>
    <body><a href="https://wa.me/97150">WhatsApp</a><a href="tel:+97150">Call</a></body></html>`;
  const s = detectSiteSignals(html, ['https://metrics.glowstudio.ae/gtm.js?id=GTM-1'], 'www.glowstudio.ae');
  assert.strictEqual(s.consent_tool, 'Cookiebot');
  assert.deepStrictEqual(s.other_tools, ['Meta', 'HubSpot']);
  assert.deepStrictEqual(s.contact, { whatsapp: true, phone: true });
  assert.strictEqual(s.server_side_gtm, true, 'a first-party gtm.js is server-side tagging');
  assert.strictEqual(s.maintenance, false);
  assert.strictEqual(s.landing_page_host, false);
  const soon = detectSiteSignals('<html><head><title>Coming soon</title></head><body>Under construction</body></html>', [], 'new.example');
  assert.strictEqual(soon.maintenance, true);
  assert.strictEqual(detectSiteSignals('<html></html>', [], 'linktr.ee').landing_page_host, true);
  assert.strictEqual(detectSiteSignals('<html></html>', ['https://www.googletagmanager.com/gtm.js?id=GTM-1'], 'glowstudio.ae').server_side_gtm, false, 'Google-hosted gtm.js is the normal setup');
});

test('findings strip (fix plan move 3): tones, consent is not a fault, no tracking is the first fix, link pages are named', () => {
  const { findingsStrip } = require('../src/findings-strip');
  const base = { status: 'complete', booking_provider: null };
  const consent = findingsStrip({ ...base, tags_found: { gtm_containers: ['GTM-1'], ga4_ids: [], legacy_ua: [], seen: { consent_tool: 'OneTrust', other_tools: [], contact: {} } } });
  assert.strictEqual(consent.visible_issue_count, 0);
  assert.strictEqual(consent.tones[1], 'ok');
  assert.match(consent.items[1], /Waits for cookie consent \(OneTrust\)/);
  const bare = findingsStrip({ ...base, tags_found: { gtm_containers: ['GTM-1'], ga4_ids: [], legacy_ua: [] } });
  assert.strictEqual(bare.visible_issue_count, 1);
  assert.match(bare.items[1], /couldn't see it recording/);
  const none = findingsStrip({ ...base, booking_provider: 'fresha', tags_found: { gtm_containers: [], ga4_ids: [], legacy_ua: [], seen: { other_tools: ['Meta'], contact: { whatsapp: true, phone: false } } } });
  assert.strictEqual(none.no_tracking, true);
  assert.strictEqual(none.tones[0], 'issue');
  assert.match(none.items[0], /first thing to fix/);
  assert.ok(none.items.some((t) => /Fresha/.test(t)) && none.items.some((t) => /WhatsApp/.test(t)) && none.items.some((t) => /Meta/.test(t)));
  assert.strictEqual(none.tones.length, none.items.length);
  const link = findingsStrip({ ...base, tags_found: { gtm_containers: [], ga4_ids: [], seen: { landing_page_host: true } } });
  assert.strictEqual(link.landing_page, true);
  assert.match(link.headline, /link page/);
});

test('findings strip carries pages read (fix plan move 16)', () => {
  const { findingsStrip } = require('../src/findings-strip');
  const s = findingsStrip({ status: 'complete', booking_provider: null, pages_crawled: 6, tags_found: { gtm_containers: ['GTM-1'], ga4_ids: ['G-1'], legacy_ua: [] } });
  assert.strictEqual(s.pages_read, 6);
});

test('booking provider detection', () => {
  assert.strictEqual(detectBookingProvider('<a href="https://wa.me/9715xxxxxxx">chat</a>'), 'whatsapp');
  assert.strictEqual(detectBookingProvider('<a href="https://www.fresha.com/x">book</a>'), 'fresha');
  assert.strictEqual(detectBookingProvider('<p>nothing</p>'), null);
});

test('key page derivation: same-origin, hint-matched, capped at 5', () => {
  const html = `
    <a href="/contact">Contact</a>
    <a href="/services">Services</a>
    <a href="/booking">Book now</a>
    <a href="/about">About</a>
    <a href="https://other.com/contact">External</a>
    <a href="/shop">Shop</a>
    <a href="/pricing">Pricing</a>
    <a href="/menu">Menu</a>`;
  const pages = deriveKeyPages(html, 'https://example.com/', 5);
  assert.strictEqual(pages.length, 5);
  assert.ok(pages.every((p) => p.startsWith('https://example.com/')));
  assert.ok(!pages.includes('https://example.com/about'));
});
