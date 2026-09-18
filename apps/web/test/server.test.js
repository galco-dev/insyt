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
      return [...crawls.values()].filter((c) => c.domain === domain && c.created_at >= since && c.status !== 'failed').length;
    },
    recentCrawlForDomain(domain, since) {
      const hit = [...crawls.entries()].filter(([, c]) => c.domain === domain && c.created_at >= since && c.status !== 'failed').pop();
      return hit ? { id: hit[0], status: hit[1].status, created_at: hit[1].created_at } : null;
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
    assert.match(got.strip.headline, /worth fixing|looks healthy/);
    const page = await (await fetch(`${base}/check/${id}`)).text();
    assert.ok(page.includes('Checking your website'));
  });
});

test('repeat checks: a recent check of the same domain is shown again (same id), never refused; a failed check never locks the visitor out', async () => {
  const store = mkStore();
  await withApp({ store, crawler: okCrawler }, async (base) => {
    const first = await (await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'x.com' }) })).json();
    await new Promise((r) => setTimeout(r, 30));
    const second = await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'https://x.com/page' }) });
    assert.strictEqual(second.status, 202);
    const body = await second.json();
    assert.deepStrictEqual({ id: body.id, reused: body.reused }, { id: first.id, reused: true });
  });
  const failing = { discoveryCrawl: async () => { throw new Error('browser died'); } };
  const store2 = mkStore();
  await withApp({ store: store2, crawler: failing }, async (base) => {
    await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'y.com' }) });
    await new Promise((r) => setTimeout(r, 30));
    const retry = await fetch(`${base}/api/crawl`, { method: 'POST', body: JSON.stringify({ url: 'y.com' }) });
    assert.strictEqual(retry.status, 202, 'retry after a failure is allowed');
    const body = await retry.json();
    assert.ok(!body.reused);
  });
});

test('magic link: view_report redirects once, then the link is dead', async () => {
  const store = mkStore();
  const { token } = mintLink({ tenantId: 'tn1', purpose: 'view_report', targetId: 'rep1', baseUrl: 'http://x', now: Date.now() }, store.magicLinks);
  await withApp({ store, crawler: okCrawler }, async (base) => {
    const first = await fetch(`${base}/m/${token}`, { redirect: 'manual' });
    assert.strictEqual(first.status, 302);
    // The one-tap link lands in the app, signed in (fix plan move 4); /r/ stays for old links.
    assert.strictEqual(first.headers.get('location'), '/app/report/rep1');
    assert.ok(/insyt_s=/.test(first.headers.get('set-cookie') || ''), 'redemption signs the tenant in');
    const report = await fetch(`${base}/r/rep1`);
    assert.ok((await report.text()).includes('report body'));
    const again = await fetch(`${base}/m/${token}`, { redirect: 'manual' });
    assert.strictEqual(again.status, 410);
    const gone = await again.text();
    assert.ok(gone.includes('already used'));
    assert.match(gone, /href="\/app"/, 'the used-link page carries a real link to the dashboard (QA-006)');
  });
});

test('session (fix plan move 12): a viewer role rides in the cookie and reads back; old cookies are owners', () => {
  const { issueSession, readSession } = require('../src/session');
  const now = 1_000_000;
  const viewer = issueSession({ tenantId: 'tn1', secret: 's', now, role: 'viewer' });
  assert.deepStrictEqual(readSession(`insyt_s=${viewer}`, 's', now + 10), { tenantId: 'tn1', role: 'viewer' });
  const owner = issueSession({ tenantId: 'tn1', secret: 's', now });
  assert.deepStrictEqual(readSession(`insyt_s=${owner}`, 's', now + 10), { tenantId: 'tn1', role: 'owner' });
  assert.strictEqual(readSession(`insyt_s=${viewer}x`, 's', now + 10), null, 'tampered role is rejected');
});

test('crawl (fix plan move 16): a forced check skips the hour reuse once it is five minutes old; the answer says when it was checked', async () => {
  const store = mkStore();
  const t0 = Date.now() - 10 * 60_000;
  const id = await store.createCrawl({ url: 'https://glowstudio.ae/', domain: 'glowstudio.ae', status: 'running', created_at: t0 });
  await store.patchCrawl(id, { status: 'complete', strip: { headline: 'ok', items: [], tones: [] } });
  await withApp({ store, crawler: okCrawler, now: () => Date.now() }, async (base) => {
    const reused = await (await fetch(`${base}/api/crawl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'glowstudio.ae' }) })).json();
    assert.strictEqual(reused.reused, true);
    assert.strictEqual(reused.checked_at, t0);
    const status = await (await fetch(`${base}/api/crawl/${reused.id}`)).json();
    assert.strictEqual(status.checked_at, t0);
    const forced = await (await fetch(`${base}/api/crawl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'glowstudio.ae', force: true }) })).json();
    assert.ok(forced.id && forced.id !== reused.id && !forced.reused, 'a fresh check runs');
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
