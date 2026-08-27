#!/usr/bin/env node
// Post-deploy smoke — launch-audit-spec §10. Read-only against the live app:
//   node scripts/smoke.js [https://app.tryinsyt.com]
// Exit 1 on any failure. No secrets needed; nothing is written except one
// free check against a fixed domain (subject to the normal per-domain limits).

const base = (process.argv[2] || process.env.APP_BASE_URL || 'https://app.tryinsyt.com').replace(/\/$/, '');
const SMOKE_DOMAIN = process.env.SMOKE_DOMAIN || 'www.thenaildxb.net';

const results = [];
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true, detail }); }
  catch (e) { results.push({ name, ok: false, detail: e.message }); }
}
const get = (path, opts = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...opts });

(async () => {
  await check('healthz', async () => {
    const r = await get('/healthz'); if (r.status !== 200) throw new Error(`status ${r.status}`); return 'ok';
  });
  await check('root redirects into the funnel', async () => {
    const r = await get('/'); const loc = r.headers.get('location') || '';
    if (r.status !== 302 || !loc.startsWith('/app/start')) throw new Error(`${r.status} -> ${loc}`); return loc;
  });
  await check('security headers', async () => {
    const r = await get('/healthz');
    for (const h of ['strict-transport-security', 'x-content-type-options', 'x-frame-options']) if (!r.headers.get(h)) throw new Error(`missing ${h}`);
    return 'present';
  });
  await check('SPA serves /app/start', async () => {
    const r = await get('/app/start'); const t = await r.text();
    if (r.status !== 200 || !/index-[\w-]+\.js/.test(t)) throw new Error(`status ${r.status}`); return 'bundle referenced';
  });
  await check('signed-out /app shows sign-in (200, not a loop)', async () => {
    const r = await get('/app'); if (r.status !== 200) throw new Error(`status ${r.status}`); return 'ok';
  });
  await check('auth start redirects to Google with identity + read scopes', async () => {
    const r = await get('/auth/google/start?step=discovery&site=example.com'); const loc = r.headers.get('location') || '';
    if (r.status !== 302 || !loc.startsWith('https://accounts.google.com')) throw new Error(`${r.status} -> ${loc.slice(0, 80)}`);
    for (const s of ['openid', 'adwords', 'analytics.readonly', 'tagmanager.readonly']) if (!loc.includes(s)) throw new Error(`scope missing: ${s}`);
    return 'ok';
  });
  await check('auth start for write scopes needs a session', async () => {
    const r = await get('/auth/google/start?step=write'); if (r.status !== 302 || r.headers.get('location') !== '/') throw new Error(`${r.status}`); return 'redirected home';
  });
  await check('crawl API rejects junk', async () => {
    const r = await get('/api/crawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'not a site' }) });
    if (r.status !== 400) throw new Error(`status ${r.status}`); return 'ok';
  });
  await check(`free check on ${SMOKE_DOMAIN} completes`, async () => {
    const r = await get('/api/crawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: SMOKE_DOMAIN }) });
    const body = await r.json();
    if (r.status === 429) return 'rate-limited (recent check exists) - skipped';
    if (r.status !== 202 || !body.id) throw new Error(`status ${r.status} ${JSON.stringify(body)}`);
    const started = Date.now();
    while (Date.now() - started < 4 * 60_000) {
      await new Promise((res) => setTimeout(res, 3000));
      const c = await (await get(`/api/crawl/${body.id}`)).json();
      if (c.status === 'complete') return c.strip && c.strip.headline;
      if (c.status && c.status !== 'running') throw new Error(`crawl ${c.status}`);
    }
    throw new Error('timed out');
  });
  await check('stripe webhook rejects unsigned posts', async () => {
    const r = await get('/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (![400, 404].includes(r.status)) throw new Error(`status ${r.status}`); return `status ${r.status}`;
  });
  await check('ops is token-protected', async () => {
    const r = await get('/ops'); if (r.status === 200) throw new Error('open!'); return `status ${r.status}`;
  });

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
