// Ops console — build-doc §15. Internal, Max-only: bearer OPS_TOKEN.
// A table-and-buttons admin, deliberately not a product.
//
// deps: opsStore (packages/db/src/stores.js contract) + queue { enqueue }.

const FONT = "'Geist', Helvetica, Arial, sans-serif";

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ops · ${esc(title)}</title>
<style>body{font-family:${FONT};margin:24px;color:#000d14;} table{border-collapse:collapse;width:100%;margin:12px 0;}
td,th{border:1px solid #e6e6e6;padding:6px 10px;font-size:13px;text-align:left;} th{background:#f7f7f7;}
a{color:#2563EB;} button{padding:4px 10px;border:1px solid #d1d1d1;border-radius:6px;background:#fff;cursor:pointer;}</style>
</head><body><p><a href="/ops">tenants</a> · <a href="/ops/runs">runs</a></p><h2>${esc(title)}</h2>${body}</body></html>`;
}

function authorized(req, opsToken) {
  const h = req.headers.authorization || '';
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('ops='));
  return opsToken && (h === `Bearer ${opsToken}` || (cookie && cookie.slice(4) === opsToken));
}

/** Returns true when the request was handled (an /ops route). */
async function handleOps(req, res, u, { opsStore, queue, opsToken }) {
  const path = u.pathname;
  if (!path.startsWith('/ops')) return false;

  const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  if (!authorized(req, opsToken)) {
    // token=? in the query sets the cookie once (Max's bookmark).
    const t = u.searchParams.get('token');
    if (t && t === opsToken) {
      res.writeHead(302, { 'set-cookie': `ops=${t}; HttpOnly; Path=/ops; Max-Age=2592000`, location: '/ops' });
      return res.end(), true;
    }
    return html(401, page('locked', '<p>Bearer token required.</p>')), true;
  }

  // §11.9 monthly review artefact, rendered as-is (internal register).
  if (req.method === 'GET' && path === '/ops/learning') {
    const rows = opsStore.learningReviews ? await opsStore.learningReviews() : [];
    const body = rows.length
      ? rows.map((r) => `<h3>${esc(r.month)}</h3><p>${(r.incidents || []).length} telemetry incident(s) · ${((r.proposals || {}).chosen || []).length} tuning(s) proposed</p><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;border:1px solid #ddd;padding:12px;">${esc(r.body_md)}</pre>`).join('')
      : '<p>No learning review yet. The job runs monthly on the cron service.</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Learning reviews', body));
    return true;
  }
  if (req.method === 'GET' && path === '/ops') {
    const [tenants, subs, cogs] = await Promise.all([opsStore.tenants(), opsStore.subscriptions(), opsStore.cogsByTenant()]);
    const subBy = new Map(subs.map((s) => [s.tenant_id, s]));
    const cogsBy = new Map(cogs.map((c) => [c.tenant_id, c.sum ?? c.cost_usd ?? 0]));
    const mrr = subs.filter((s) => s.status === 'active').reduce((a, s) => a + Number(s.price_usd || 0), 0);
    const rows = tenants.map((t) => {
      const s = subBy.get(t.id);
      const cost = Number(cogsBy.get(t.id) || 0);
      const whale = s && cost > 2 * Number(s.price_usd || Infinity) ? ' 🐋' : '';
      return `<tr><td>${esc(t.business_name || t.website_url || t.id)}</td><td>${esc(t.status)}</td>
        <td>${s ? `${esc(s.tier)}/${esc(s.size_band)} $${esc(s.price_usd)}` : '—'}</td>
        <td>$${cost.toFixed(2)}${whale}</td>
        <td><a href="/ops/ledger/${esc(t.id)}">ledger</a> ·
          <form method="post" action="/ops/run/${esc(t.id)}" style="display:inline"><button>run now</button></form></td></tr>`;
    }).join('');
    return html(200, page(`tenants — MRR $${mrr}`, `<table><tr><th>tenant</th><th>status</th><th>plan</th><th>COGS/mo</th><th></th></tr>${rows}</table>`)), true;
  }

  if (req.method === 'GET' && path === '/ops/runs') {
    const runs = await opsStore.recentRuns();
    const rows = runs.map((r) => `<tr><td>${esc(r.id).slice(0, 8)}</td><td>${esc(r.tenant_id).slice(0, 8)}</td>
      <td>${esc(r.type)}</td><td>${esc(r.status)}</td><td>${esc(r.started_at || '')}</td><td>$${esc(r.cogs_usd)}</td></tr>`).join('');
    return html(200, page('runs', `<table><tr><th>run</th><th>tenant</th><th>type</th><th>status</th><th>started</th><th>COGS</th></tr>${rows}</table>`)), true;
  }

  if (req.method === 'GET' && path.startsWith('/ops/ledger/')) {
    const rows = (await opsStore.ledgerFor(path.split('/')[3]))
      .map((l) => `<tr><td>${esc(l.created_at)}</td><td>${esc(l.event)}</td><td>${esc(l.summary_text)}</td><td>${l.money_impact_usd ? '$' + esc(l.money_impact_usd) : ''}</td></tr>`).join('');
    return html(200, page('ledger', `<table><tr><th>at</th><th>event</th><th>summary</th><th>$</th></tr>${rows}</table>`)), true;
  }

  if (req.method === 'POST' && path.startsWith('/ops/run/')) {
    const tenantId = path.split('/')[3];
    const run = await opsStore.enqueueRun({ tenant_id: tenantId, type: 'triggered', status: 'queued', idempotency_key: `manual:${tenantId}:${Date.now()}` });
    await queue.enqueue('runs-triggered', run);
    res.writeHead(302, { location: '/ops' });
    return res.end(), true;
  }

  return html(404, page('not found', '')), true;
}

module.exports = { handleOps, authorized };
