// Discovery crawl — build-doc §5.
// Playwright chromium; homepage rendered with a 15s budget, then ≤5 nav-derived
// key pages. Emits a `crawls`-row-shaped object. Robots.txt respected for depth
// pages; homepage always fetched. No crawl of login-walled pages.

const { chromium } = require('playwright');
const {
  extractTags, fingerprintCms, detectBookingProvider, deriveKeyPages, extractPrices,
} = require('./extract');

const HOMEPAGE_BUDGET_MS = 15_000;
const DEPTH_BUDGET_MS = 10_000;

async function fetchRobots(origin) {
  try {
    const res = await fetch(origin + '/robots.txt', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return () => true;
    const text = await res.text();
    const disallows = [];
    let applies = false;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      if (/^user-agent:\s*\*/i.test(line)) { applies = true; continue; }
      if (/^user-agent:/i.test(line)) { applies = false; continue; }
      if (applies) {
        const m = /^disallow:\s*(\S+)/i.exec(line);
        if (m) disallows.push(m[1]);
      }
    }
    return (path) => !disallows.some((d) => d !== '/' && path.startsWith(d));
  } catch {
    return () => true;
  }
}

async function renderPage(context, url, budgetMs) {
  const page = await context.newPage();
  const requestUrls = [];
  page.on('request', (r) => requestUrls.push(r.url()));
  let headers = {};
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: budgetMs });
    if (resp) headers = resp.headers();
    await page.waitForTimeout(Math.min(3000, budgetMs / 3)); // let tags fire
    const html = await page.content();
    return { ok: true, html, headers, requestUrls };
  } catch (err) {
    return { ok: false, error: String(err.message || err), html: '', headers, requestUrls };
  } finally {
    await page.close();
  }
}

function mergeTags(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])];
  }
  return out;
}

/**
 * Run a discovery crawl.
 * @param {string} url        The site to crawl.
 * @param {object} [opts]     { executablePath } for pinned chromium builds.
 * @returns crawls-row-shaped object (§1.2).
 */
async function discoveryCrawl(url, opts = {}) {
  const started = Date.now();
  const target = new URL(url.startsWith('http') ? url : 'https://' + url);
  const launchOpts = {};
  if (opts.executablePath) launchOpts.executablePath = opts.executablePath;
  // Respect an outbound proxy (sandboxed/dev environments); harmless when unset.
  const proxyServer = opts.proxy !== undefined
    ? opts.proxy // explicit null disables proxying (e.g. localhost targets)
    : (process.env.HTTPS_PROXY || process.env.https_proxy);
  if (proxyServer) launchOpts.proxy = { server: proxyServer };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; InsytBot/0.1; +https://tryinsyt.com)',
    viewport: { width: 1366, height: 900 },
    // Dev-proxy TLS interception only — never set in production.
    ignoreHTTPSErrors: process.env.INSYT_INSECURE_TLS === '1',
  });

  try {
    // 1. Homepage — always fetched.
    const home = await renderPage(context, target.href, HOMEPAGE_BUDGET_MS);
    if (!home.ok && !home.html) {
      return {
        url: target.href, status: 'failed', error: home.error,
        cms_fingerprint: null, tags_found: {}, booking_provider: null,
        pages_crawled: 0, duration_ms: Date.now() - started,
      };
    }

    let tags = extractTags(home.html, home.requestUrls);
    let prices = extractPrices(home.html);
    const cms = fingerprintCms(home.html, home.headers);
    let booking = detectBookingProvider(home.html);

    // 2. Key pages — nav-derived, robots-respected, ≤5.
    const allowed = await fetchRobots(target.origin);
    const keyPages = deriveKeyPages(home.html, target.href, 5)
      .filter((p) => allowed(new URL(p).pathname));

    let crawled = 1;
    const pages = [{ url: target.href, ok: home.ok }];
    for (const pageUrl of keyPages) {
      const res = await renderPage(context, pageUrl, DEPTH_BUDGET_MS);
      pages.push({ url: pageUrl, ok: res.ok });
      if (res.ok) {
        crawled += 1;
        tags = mergeTags(tags, extractTags(res.html, res.requestUrls));
        prices = prices.concat(extractPrices(res.html).filter((p) => !prices.some((q) => q.label === p.label && q.amount === p.amount)));
        booking = booking || detectBookingProvider(res.html);
      }
    }

    return {
      url: target.href,
      status: 'complete',
      cms_fingerprint: cms,
      tags_found: tags,
      prices,
      booking_provider: booking,
      pages_crawled: crawled,
      pages,
      duration_ms: Date.now() - started,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { discoveryCrawl };
