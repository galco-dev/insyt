const assert = require('node:assert');
const { test } = require('node:test');
const { createApp } = require('../src/server');
const { mintLink } = require('../../../packages/emails/src/magic-links');

function mkStore() {
  const crawls = new Map(); let nextId = 1;
  const linkRows = []; let linkId = 1;
  return {
    createCrawl(row) { const id = String(nextId++); crawls.set(id, row); return id; },
    getCrawl(id) { return crawls.get(id); },
    patchCrawl(id, patch) { Object.assign(crawls.get(id), patch); },
    crawlCountForDomain(domain, since) {
      return [...crawls.values()].filter((c) => c.domain === domain && c.created_at >= since).length;
    },
    getReportHtml(id) { return id === 'rep1' ? { html_web: '<!doctype html><p>report body</p>' } : null; },
    magicLinks: {
      insertLink: (r) => linkRows.push({ id: linkId++, ...r }),
      findByHash: (h) => linkRows.find((r) => r.token_hash === h) || null,
      markUsed: (id, at) => { linkRows.find((r) => r.id === id).used_at = at; },
    },
  };
}

async function withApp(deps, fn) {
  const app = createApp(deps);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { app.close(); }
}

const okCrawler = { discoveryCrawl: async () => ({ status: 'complete', tags_found: { gtm_containers: ['GTM-1'], ga4_ids: [] }, booking_provider: null }) };

test('journey A slice: paste URL -> crawl -> findings strip', async () => {
  const store = mkStore();
  await withApp({ store, crawler: okCrawler }, async (base) => {
    const post = await fetch(`${base}/api/crawl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'salon-example.com' }) });
    assert.strictEqual(post.status, 202);
    const { id } = await post.json();
    await new Promise((r) => setTimeout(r, 30)); // let the stub crawl settle
    const got = await (await fetch(`${base}/api/crawl/${id}`)).json();
    assert.strictEqual(got.status, 'complete');
    assert.match(got.strip.headline, /Found:/);
    const page = await (await fetch(`${base}/check/${id}`)).text();
    assert.ok(page.includes('Checking your website'));
  });
});

test('rate limits: second crawl of a domain within the hour is refused politely', async () => {
  const store = mkStore();
  await withApp({ store, crawler: okCrawler }, async (base) => {
    const first = await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'x.com' }) });
    assert.strictEqual(first.status, 202);
    const second = await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'https://x.com/page' }) });
    assert.strictEqual(second.status, 429);
    const body = await second.json();
    assert.ok(!/rate limit/i.test(body.error), 'register: no infra jargon in the refusal');
  });
});

test('magic link: view_report redirects once, then the link is dead', async () => {
  const store = mkStore();
  const { token } = mintLink({ tenantId: 'tn1', purpose: 'view_report', targetId: 'rep1', baseUrl: 'http://x', now: Date.now() }, store.magicLinks);
  await withApp({ store, crawler: okCrawler }, async (base) => {
    const first = await fetch(`${base}/m/${token}`, { redirect: 'manual' });
    assert.strictEqual(first.status, 302);
    assert.strictEqual(first.headers.get('location'), '/r/rep1');
    const report = await fetch(`${base}/r/rep1`);
    assert.ok((await report.text()).includes('report body'));
    const again = await fetch(`${base}/m/${token}`, { redirect: 'manual' });
    assert.strictEqual(again.status, 410);
    assert.ok((await again.text()).includes('already used'));
  });
});

test('landing + health', async () => {
  await withApp({ store: mkStore(), crawler: okCrawler }, async (base) => {
    const landing = await (await fetch(base + '/')).text();
    assert.ok(landing.includes('Paste your website'));
    assert.ok(landing.includes('read access'), 'trust microcopy present');
    const hz = await (await fetch(base + '/healthz')).json();
    assert.deepStrictEqual(hz, { ok: true });
  });
});

test('bad url and unknown routes fail gracefully', async () => {
  await withApp({ store: mkStore(), crawler: okCrawler }, async (base) => {
    const bad = await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'ht!tp:/ /nope' }) });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await fetch(`${base}/api/crawl/999`)).status, 404);
    assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
  });
});
