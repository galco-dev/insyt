// End-to-end crawl against a local fixture site — proves the full Playwright
// path (render, request capture, robots, key-page walk) without external network.
// Run: node --test packages/crawler/test/e2e.local.test.js
// Needs chromium; pass INSYT_CHROMIUM=/path/to/chromium if not using default install.
const assert = require('node:assert');
const { test } = require('node:test');
const { startFixture } = require('./fixture-site');
const { discoveryCrawl } = require('../src/crawl');
const { findingsStrip } = require('../src/findings-strip');

test('e2e: crawls fixture site and extracts everything', async () => {
  const { server, port } = await startFixture();
  try {
    const result = await discoveryCrawl(`http://127.0.0.1:${port}/`, {
      executablePath: process.env.INSYT_CHROMIUM,
      proxy: null, // localhost — never proxy
    });

    assert.strictEqual(result.status, 'complete');
    assert.strictEqual(result.cms_fingerprint, 'wordpress');
    assert.deepStrictEqual(result.tags_found.gtm_containers, ['GTM-TEST123']);
    assert.deepStrictEqual(result.tags_found.ga4_ids, ['G-FIXTURE001']);
    assert.deepStrictEqual(result.tags_found.legacy_ua, ['UA-99887766-1']);
    assert.strictEqual(result.booking_provider, 'whatsapp');
    // homepage + contact + services + booking; /secret-admin robots-blocked; /about not a hint match
    assert.strictEqual(result.pages_crawled, 4);
    assert.ok(!result.pages.some((p) => p.url.includes('secret-admin')), 'robots.txt respected');

    const strip = findingsStrip(result);
    assert.ok(strip.visible_issue_count >= 1, 'legacy UA should surface as an issue');
    assert.ok(strip.items.some((i) => /Outdated tracking/.test(i)));
    assert.ok(strip.items.some((i) => /WhatsApp/.test(i)));
  } finally {
    server.close();
  }
});
