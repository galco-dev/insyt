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
