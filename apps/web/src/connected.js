// Connected data — the transparency screen behind Settings → "See what Insyt
// reads". One tab per Google API the customer granted, each showing the raw
// objects that API returns for THEIR accounts, in Google's own names:
//
//   Google Ads API (adwords)        account, campaigns, conversion actions,
//                                   search terms; pause a campaign or add
//                                   negative keywords (approved changes that
//                                   run through the normal executor + Undo)
//   Analytics Data/Admin (readonly) property, 28-day daily report, event
//                                   totals; CSV export of the report
//   Tag Manager API (readonly)      account → container → workspace → tags,
//                                   triggers, variables, versions
//
// Nothing here bypasses the write model: an action inserts an APPROVED change
// row (the tap is the approval, exactly like Undo) and the worker's apply
// loop performs the write within a minute, logs it to the ledger, and History
// offers Undo through the registry rollback.
//
// deps: { db, auth (packages/google client), developerToken, mccId, now }

const { fetchAds, search } = require('../../../packages/google/src/fetch-ads');
const { fetchGa4Config } = require('../../../packages/google/src/fetch-ga4');
const { fetchGtmSnapshot } = require('../../../packages/google/src/fetch-gtm');

const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';
// Changes born here are recognisable by their change_key prefix. (`category`
// on the changes table is the autopilot category and is DB-constrained to
// negatives | budgets | counting, so it is left null: always ask-first.)
const KEY_PREFIX = 'connected:';
const SOURCE = 'connected_data';

const q = (s) => encodeURIComponent(s);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  req.on('data', (c) => { body += c; });
  await new Promise((r) => req.on('end', r));
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createConnected({ db, auth, developerToken = null, mccId = '3315824995', now = Date.now }) {
  const configured = !!auth;

  const asset = (tenantId, kind) => db.select('assets',
    `tenant_id=eq.${q(tenantId)}&kind=eq.${kind}&linked=eq.true&select=id,external_id,display_name,currency,metadata&limit=1`, { single: true });
  const loginFor = (a) => (a && a.metadata && a.metadata.under_mcc ? mccId : (a ? a.external_id : mccId));

  // ------------------------------------------------------------ Google Ads
  async function adsView(tenantId) {
    const a = await asset(tenantId, 'ads_account');
    if (!a) return { linked: false, reason: 'No Google Ads account is linked to this Insyt account yet.' };
    if (!developerToken) return { linked: true, reason: 'Google Ads reads are not configured on this deployment.' };
    const ctx = { auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: loginFor(a) };
    const [ads, customer, adGroups] = await Promise.all([
      fetchAds(ctx),
      search({ ...ctx, query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status FROM customer' }),
      search({ ...ctx, query: 'SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != \'REMOVED\'' }).catch(() => []),
    ]);
    const c = (customer[0] && customer[0].customer) || {};
    const groupsByCampaign = new Map();
    for (const r of adGroups) {
      const cid = String(r.campaign.id);
      if (!groupsByCampaign.has(cid)) groupsByCampaign.set(cid, []);
      groupsByCampaign.get(cid).push({ id: String(r.adGroup.id), name: r.adGroup.name, status: String(r.adGroup.status || '').toLowerCase() });
    }
    // Recent actions taken from this screen, so the table can show their state.
    const changes = await connectedChanges(tenantId);
    const pendingPause = new Set(changes.filter((ch) => ch.tool_id === 'ads.pause_campaign' && ['proposed', 'approved'].includes(ch.status)).map((ch) => String(ch.params.campaign_id)));
    return {
      linked: true,
      api: 'Google Ads API',
      scope: 'https://www.googleapis.com/auth/adwords',
      account: {
        customer_id: String(a.external_id),
        customer_id_display: String(a.external_id).replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3'),
        name: c.descriptiveName || a.display_name || null,
        currency_code: c.currencyCode || ads.currency_code || a.currency || null,
        time_zone: c.timeZone || null,
        status: c.status || null,
        spend_30d: r2(ads.spend_30d_usd),
        spend_90d: r2(ads.spend_90d_usd),
        conversions_30d: ads.ads_conversions_30d,
      },
      campaigns: ads.campaigns
        .map((cp) => ({
          id: cp.id, name: cp.name, status: cp.status, bidding: cp.bidding,
          budget_daily: r2(cp.budget_daily_usd), spend_30d: r2(cp.spend_30d_usd), conversions_30d: r2(cp.conversions_30d),
          budget_lost_is_pct: cp.budget_lost_is_pct, ad_groups: groupsByCampaign.get(String(cp.id)) || [],
          pause_pending: pendingPause.has(String(cp.id)),
        }))
        .sort((x, y) => y.spend_30d - x.spend_30d),
      conversion_actions: ads.conversion_actions.map((ca) => ({ id: ca.id, name: ca.name, primary: ca.primary, source: ca.source, category: ca.conversion_category, count_30d: ca.count_30d })),
      search_terms: ads.search_terms
        .sort((x, y) => y.spend_90d_usd - x.spend_90d_usd).slice(0, 50)
        .map((t) => ({ term: t.term, campaign_id: t.campaign_id, spend_90d: r2(t.spend_90d_usd), clicks_90d: t.clicks_90d, conversions_90d: r2(t.conversions_90d) })),
      disapproved: ads.disapproved,
      changes,
      fetched_at: new Date(now()).toISOString(),
    };
  }

  async function connectedChanges(tenantId) {
    const rows = await db.select('changes',
      `tenant_id=eq.${q(tenantId)}&change_key=like.${q(`${KEY_PREFIX}*`)}&select=id,tool_id,status,params,after,summary_text,created_at,applied_at,reverts_change_id&order=created_at.desc&limit=30`).catch(() => []);
    return rows || [];
  }

  async function latestRunId(tenantId) {
    const run = await db.select('runs', `tenant_id=eq.${q(tenantId)}&select=id,finished_at&order=finished_at.desc.nullslast&limit=1`, { single: true }).catch(() => null);
    return run ? run.id : null;
  }

  // The tap is the approval. Same birth state as an Undo (stores.requestRevert):
  // status approved, actor user, an approvals row, a ledger line, then the
  // worker applies it within a minute and History shows the result with Undo.
  async function queueChange(tenantId, { tool_id, params, target, title, summary, before, after }) {
    const runId = await latestRunId(tenantId);
    if (!runId) return { error: 'Run your first check before making changes from here.' };
    const [finding] = await db.insert('findings', [{
      run_id: runId, tenant_id: tenantId, rule_id: 'user.connected_action', layer: 4, severity: 'info', status: 'open',
      title, explanation: 'You asked for this from the Connected data screen. It runs through the same approval, ledger and Undo path as every other change.',
      payload: { source: SOURCE, tool_id, params }, fix_available: true, first_seen_run_id: runId, first_seen_at: new Date(now()).toISOString(),
    }]);
    const [change] = await db.insert('changes', [{
      tenant_id: tenantId, finding_id: finding.id, tool_id, params, status: 'approved', actor: 'user',
      category: null, change_key: `${KEY_PREFIX}${tool_id}:${target}`, target,
      summary_text: summary, before: { line: before }, after: { line: after },
      idempotency_key: `${KEY_PREFIX}${tool_id}:${target}:${now()}`,
    }]);
    await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: change.id, channel: 'dashboard' }], { returning: false }).catch(() => {});
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'approval', change_id: change.id, actor: 'user', summary_text: `You approved: ${summary}. It is being applied now.` }], { returning: false }).catch(() => {});
    await db.insert('audit_log', [{ tenant_id: tenantId, event: 'connected_action', detail: { change_id: change.id, tool_id, params } }], { returning: false }).catch(() => {});
    return { ok: true, change: { id: change.id, tool_id, status: 'approved', params, summary_text: summary } };
  }

  async function campaignName(tenantId, campaignId) {
    const a = await asset(tenantId, 'ads_account');
    if (!a || !developerToken) return null;
    const rows = await search({ auth, tenantId, customerId: a.external_id, developerToken, loginCustomerId: loginFor(a),
      query: `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${String(campaignId).replace(/\D/g, '')}` }).catch(() => []);
    return rows[0] ? { name: rows[0].campaign.name, status: String(rows[0].campaign.status || '').toLowerCase() } : null;
  }

  async function pauseCampaign(tenantId, campaignId) {
    const cid = String(campaignId).replace(/\D/g, '');
    if (!cid) return { error: 'campaign_id required' };
    const c = await campaignName(tenantId, cid);
    if (!c) return { error: 'That campaign is not in the linked Google Ads account.' };
    if (c.status === 'paused') return { error: `"${c.name}" is already paused.` };
    return queueChange(tenantId, {
      tool_id: 'ads.pause_campaign', params: { campaign_id: cid }, target: `campaign:${cid}:status`,
      title: `Pause "${c.name}"`, summary: `Paused "${c.name}"`,
      before: `"${c.name}" is running`, after: `"${c.name}" is paused; Undo turns it back on`,
    });
  }

  async function addNegatives(tenantId, campaignId, termsRaw) {
    const cid = String(campaignId).replace(/\D/g, '');
    const terms = [...new Set((Array.isArray(termsRaw) ? termsRaw : String(termsRaw || '').split(/[\n,]/))
      .map((t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ')).filter((t) => t && t.length <= 80))].slice(0, 25);
    if (!cid || !terms.length) return { error: 'A campaign and at least one search term are required.' };
    const c = await campaignName(tenantId, cid);
    if (!c) return { error: 'That campaign is not in the linked Google Ads account.' };
    const list = terms.map((t) => `"${t}"`).join(', ');
    return queueChange(tenantId, {
      tool_id: 'ads.add_negative_keywords', params: { campaign_id: cid, terms: terms.map((text) => ({ text, match_type: 'exact' })) },
      target: `campaign:${cid}:negatives`,
      title: `Exclude ${terms.length} search${terms.length === 1 ? '' : 'es'} from "${c.name}"`,
      summary: `Excluded ${terms.length} search${terms.length === 1 ? '' : 'es'} from "${c.name}": ${list}`,
      before: `${list} can still trigger ads in "${c.name}"`, after: `${list} excluded (exact match); Undo removes the exclusions`,
    });
  }

  // ------------------------------------------------------------ Analytics
  async function ga4Report(tenantId, propertyId, days = 28) {
    const p = `properties/${propertyId}`;
    const [daily, byEvent] = await Promise.all([
      auth.api(tenantId, `${DATA}/${p}:runReport`, { method: 'POST', body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }, { name: 'eventCount' }, { name: 'keyEvents' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400,
      }) }),
      auth.api(tenantId, `${DATA}/${p}:runReport`, { method: 'POST', body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 25,
      }) }),
    ]);
    const num = (row, i) => Number((row.metricValues[i] && row.metricValues[i].value) || 0);
    const rows = (daily.rows || []).map((row) => {
      const d = row.dimensionValues[0].value;
      return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: num(row, 0), users: num(row, 1), page_views: num(row, 2), events: num(row, 3), key_events: num(row, 4) };
    });
    const totals = rows.reduce((t, r) => ({ sessions: t.sessions + r.sessions, users: t.users + r.users, page_views: t.page_views + r.page_views, events: t.events + r.events, key_events: t.key_events + r.key_events }), { sessions: 0, users: 0, page_views: 0, events: 0, key_events: 0 });
    return {
      days, rows, totals,
      events: (byEvent.rows || []).map((row) => ({ event_name: row.dimensionValues[0].value, count: num(row, 0), users: num(row, 1) })),
      row_count: Number(daily.rowCount || rows.length),
    };
  }

  async function ga4View(tenantId) {
    const a = await asset(tenantId, 'ga4_property');
    if (!a) return { linked: false, reason: 'No Google Analytics property is linked to this Insyt account yet.' };
    const [meta, config, report] = await Promise.all([
      auth.api(tenantId, `${ADMIN}/properties/${a.external_id}`).catch(() => null),
      fetchGa4Config({ auth, tenantId, propertyId: a.external_id }),
      ga4Report(tenantId, a.external_id),
    ]);
    return {
      linked: true,
      api: 'Google Analytics Data API and Admin API',
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      property: {
        id: String(a.external_id), name: (meta && meta.displayName) || a.display_name || null,
        time_zone: meta && meta.timeZone, currency_code: meta && meta.currencyCode, account: a.metadata && a.metadata.account,
        measurement_ids: config.measurement_ids, retention_months: config.retention_months,
        key_events: config.key_events.map((k) => ({ event_name: k.event_name, counting_method: k.counting_method })),
        ads_links: config.ads_links, enhanced_measurement: config.enhanced_measurement,
      },
      report,
      export_url: '/api/app/connected/ga4.csv',
      fetched_at: new Date(now()).toISOString(),
    };
  }

  async function ga4Csv(tenantId) {
    const a = await asset(tenantId, 'ga4_property');
    if (!a) return null;
    const report = await ga4Report(tenantId, a.external_id);
    const head = ['date', 'sessions', 'users', 'page_views', 'events', 'key_events'];
    const lines = [head.join(',')];
    for (const r of report.rows) lines.push(head.map((k) => csvCell(r[k])).join(','));
    lines.push(['total', report.totals.sessions, report.totals.users, report.totals.page_views, report.totals.events, report.totals.key_events].join(','));
    lines.push('');
    lines.push('event_name,event_count,users');
    for (const e of report.events) lines.push([csvCell(e.event_name), e.count, e.users].join(','));
    return { filename: `insyt-analytics-${a.external_id}-${new Date(now()).toISOString().slice(0, 10)}.csv`, body: `${lines.join('\n')}\n` };
  }

  // ------------------------------------------------------------ Tag Manager
  async function gtmView(tenantId) {
    const a = await asset(tenantId, 'gtm_container');
    if (!a) return { linked: false, reason: 'No Google Tag Manager container is linked to this Insyt account yet.' };
    const snap = await fetchGtmSnapshot({ auth, tenantId, containerPublicId: a.external_id, accountId: a.metadata && a.metadata.account_id, containerId: a.metadata && a.metadata.container_id });
    const cPath = `accounts/${snap.account_id}/containers/${snap.container_id}`;
    const wPath = `${cPath}/workspaces/${snap.workspace_id}`;
    const [account, container, workspace, variables, builtIns] = await Promise.all([
      auth.api(tenantId, `${GTM}/accounts/${snap.account_id}`).catch(() => null),
      auth.api(tenantId, `${GTM}/${cPath}`).catch(() => null),
      auth.api(tenantId, `${GTM}/${wPath}`).catch(() => null),
      auth.api(tenantId, `${GTM}/${wPath}/variables`).catch(() => ({})),
      auth.api(tenantId, `${GTM}/${wPath}/built_in_variables`).catch(() => ({})),
    ]);
    // GTM's built-in triggers never appear in the triggers list; name them.
    const BUILT_IN_TRIGGERS = { 2147479553: 'All Pages', 2147479572: 'Consent Initialization - All Pages', 2147479573: 'Initialization - All Pages' };
    const triggerName = new Map([...Object.entries(BUILT_IN_TRIGGERS), ...snap.triggers.map((t) => [String(t.id), t.name])]);
    return {
      linked: true,
      api: 'Google Tag Manager API',
      scope: 'https://www.googleapis.com/auth/tagmanager.readonly',
      account: { id: snap.account_id, name: account && account.name },
      container: { id: snap.container_id, public_id: snap.container_public_id, name: (container && container.name) || a.display_name, usage_context: container && container.usageContext },
      workspace: { id: snap.workspace_id, name: workspace && workspace.name },
      tags: snap.tags.map((t) => ({ id: t.id, name: t.name, type: t.type, paused: t.paused, measurement_id: t.measurement_id || null, event_name: t.event_name || null, triggers: t.trigger_ids.map((id) => triggerName.get(String(id)) || id) })),
      triggers: snap.triggers,
      variables: (variables.variable || []).map((v) => ({ id: String(v.variableId), name: v.name, type: v.type })),
      built_in_variables: (builtIns.builtInVariable || []).map((v) => ({ name: v.name, type: v.type })),
      versions: snap.versions ? { latest: snap.versions.latest && { version_id: snap.versions.latest.version_id, created_at: snap.versions.latest.created_at, tag_count: snap.versions.latest.tags.length }, previous: snap.versions.previous && { version_id: snap.versions.previous.version_id, created_at: snap.versions.previous.created_at, tag_count: snap.versions.previous.tags.length } } : null,
      publish_dates: snap.publish_dates.slice(0, 10),
      fetched_at: new Date(now()).toISOString(),
    };
  }

  // ------------------------------------------------------------ router
  // sub is the path after /api/app/connected (may be '' or '/…').
  async function handle(req, res, sub, tenantId) {
    if (!configured) return json(res, 503, { error: 'Google connection is not configured on this deployment.' });
    try {
      if (req.method === 'GET') {
        if (sub === '' || sub === '/') return json(res, 200, { tabs: ['ads', 'ga4', 'gtm'] });
        if (sub === '/ads') return json(res, 200, await adsView(tenantId));
        if (sub === '/ads/changes') return json(res, 200, { changes: await connectedChanges(tenantId) });
        if (sub === '/ga4') return json(res, 200, await ga4View(tenantId));
        if (sub === '/ga4.csv') {
          const csv = await ga4Csv(tenantId);
          if (!csv) return json(res, 404, { error: 'No Google Analytics property is linked.' });
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${csv.filename}"`, 'cache-control': 'no-store' });
          return res.end(csv.body);
        }
        if (sub === '/gtm') return json(res, 200, await gtmView(tenantId));
      }
      if (req.method === 'POST') {
        const m = /^\/ads\/campaigns\/(\d+)\/(pause|negatives)$/.exec(sub);
        if (m) {
          const body = await readBody(req);
          const r = m[2] === 'pause' ? await pauseCampaign(tenantId, m[1]) : await addNegatives(tenantId, m[1], body.terms);
          return json(res, r.error ? 400 : 200, r);
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 300);
      console.error(`connected ${sub} failed for ${tenantId}: ${msg}`);
      const ours = /^postgrest /.test(msg);
      return json(res, ours ? 500 : 502, { error: ours ? 'We could not record that change. It is logged; try again in a moment.' : 'Google did not answer that request. Try again in a moment.', detail: msg });
    }
  }

  return { handle, adsView, ga4View, gtmView, ga4Csv, pauseCampaign, addNegatives };
}

module.exports = { createConnected };
