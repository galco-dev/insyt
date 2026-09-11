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
async function readForm(req) {
  let body = '';
  req.on('data', (c) => { body += c; });
  await new Promise((r) => req.on('end', r));
  return Object.fromEntries(new URLSearchParams(body));
}

async function handleOps(req, res, u, { opsStore, queue, opsToken, rediscover = null }) {
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
        <td><a href="/ops/tenant/${esc(t.id)}">open</a> · <a href="/ops/ledger/${esc(t.id)}">ledger</a> ·
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

  // ---- Four ops buttons (fix plan move 15): re-run discovery, link an asset,
  // merge tenants, delete a tenant; plus the platform notice.
  if (req.method === 'GET' && path.startsWith('/ops/tenant/')) {
    if (!opsStore.tenantDetail) return html(404, page('not found', '')), true;
    const id = path.split('/')[3];
    const d = await opsStore.tenantDetail(id);
    if (!d.tenant) return html(404, page('not found', '<p>No such tenant.</p>')), true;
    const t = d.tenant;
    const assets = d.assets.map((a) => `<tr><td>${esc(a.kind)}</td><td>${esc(a.display_name || '')}</td><td>${esc(a.external_id)}</td><td>${a.linked ? 'linked' : ''} ${esc((a.metadata && a.metadata.matched_via) || '')}</td>
      <td><form method="post" action="/ops/link/${esc(id)}/${esc(a.id)}" style="display:inline"><input type="hidden" name="linked" value="${a.linked ? '0' : '1'}"><button>${a.linked ? 'unlink' : 'link'}</button></form></td></tr>`).join('');
    const users = d.users.map((x) => `<li>${esc(x.email)} · ${esc(x.role)}</li>`).join('');
    const body = `<p>${esc(t.business_name || '')} · ${esc(t.website_url || '')} · ${esc(t.status)} · band ${esc(t.size_band || '')} · <a href="/ops/ledger/${esc(id)}">ledger</a></p>
      <ul>${users}</ul>
      <p><form method="post" action="/ops/rediscover/${esc(id)}" style="display:inline"><button>re-run discovery</button></form>
         <form method="post" action="/ops/run/${esc(id)}" style="display:inline"><button>run now</button></form></p>
      <table><tr><th>kind</th><th>name</th><th>id</th><th>state</th><th></th></tr>${assets}</table>
      <h3>Merge into another tenant</h3>
      <form method="post" action="/ops/merge">People and their Google connection move to: <input name="to" placeholder="target tenant id" size="40"><input type="hidden" name="from" value="${esc(id)}"><button>merge</button></form>
      <h3>Delete this tenant</h3>
      <form method="post" action="/ops/delete/${esc(id)}" onsubmit="return confirm('Delete every row for this tenant? This cannot be undone.')">Type the tenant id to confirm: <input name="confirm" size="40"><button>delete</button></form>
      <h3>Platform notice (everyone's Home)</h3>
      <form method="post" action="/ops/notice"><input name="text" size="60" value="${esc(d.notice ? d.notice.text : '')}" placeholder="Empty clears it"><button>set</button></form>`;
    return html(200, page(`tenant ${id.slice(0, 8)}`, body)), true;
  }
  if (req.method === 'POST' && path.startsWith('/ops/rediscover/')) {
    const id = path.split('/')[3];
    if (rediscover) { try { await rediscover(id); } catch (e) { return html(500, page('rediscover failed', `<p>${esc(e.message)}</p>`)), true; } }
    res.writeHead(302, { location: `/ops/tenant/${id}` });
    return res.end(), true;
  }
  if (req.method === 'POST' && path.startsWith('/ops/link/')) {
    const [, , , tenantId, assetId] = path.split('/');
    const form = await readForm(req);
    if (opsStore.linkAsset) await opsStore.linkAsset(tenantId, assetId, form.linked !== '0');
    res.writeHead(302, { location: `/ops/tenant/${tenantId}` });
    return res.end(), true;
  }
  if (req.method === 'POST' && path === '/ops/merge') {
    const form = await readForm(req);
    if (opsStore.mergeTenants && form.from && form.to) await opsStore.mergeTenants(form.from, form.to);
    res.writeHead(302, { location: `/ops/tenant/${form.to || form.from}` });
    return res.end(), true;
  }
  if (req.method === 'POST' && path.startsWith('/ops/delete/')) {
    const id = path.split('/')[3];
    const form = await readForm(req);
    if (form.confirm !== id) return html(400, page('not deleted', '<p>The confirmation did not match the tenant id.</p>')), true;
    if (opsStore.deleteTenant) await opsStore.deleteTenant(id);
    res.writeHead(302, { location: '/ops' });
    return res.end(), true;
  }
  if (req.method === 'POST' && path === '/ops/notice') {
    const form = await readForm(req);
    if (opsStore.setNotice) await opsStore.setNotice(form.text || '');
    res.writeHead(302, { location: '/ops' });
    return res.end(), true;
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
