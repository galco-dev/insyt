// Connected data (Settings → "See what Insyt reads"): each granted Google API
// rendered as the raw objects it returns; Ads actions born as approved
// changes for the worker's apply loop; CSV export of the Analytics report.
const assert = require('node:assert');
const { test } = require('node:test');
const { createConnected } = require('../src/connected');

const TENANT = 't1';

// Fake PostgREST: assets + runs seeded; inserts captured.
function fakeDb() {
  const inserted = { findings: [], changes: [], approvals: [], ledger: [], audit_log: [] };
  const assets = [
    { id: 'as1', kind: 'ads_account', external_id: '6424596144', display_name: 'JobPeak', currency: null, metadata: {} },
    { id: 'as2', kind: 'ga4_property', external_id: '522078528', display_name: 'Jobpeak', metadata: { account: 'Job Peak' } },
    { id: 'as3', kind: 'gtm_container', external_id: 'GTM-KR92FJZS', display_name: 'www.jobpeak.net', metadata: { account_id: '6335864759', container_id: '241680754' } },
  ];
  return {
    inserted,
    select: async (table, query, opts) => {
      if (table === 'assets') {
        const kind = /kind=eq\.([a-z_0-9]+)/.exec(query)[1];
        const row = assets.find((a) => a.kind === kind) || null;
        return opts && opts.single ? row : (row ? [row] : []);
      }
      if (table === 'runs') return { id: 'run1' };
      if (table === 'changes') return inserted.changes.map((c) => ({ ...c, id: c.id || 'chg' }));
      return opts && opts.single ? null : [];
    },
    insert: async (table, rows) => {
      const withIds = rows.map((r, i) => ({ id: `${table}-${inserted[table].length + i + 1}`, ...r }));
      inserted[table].push(...withIds);
      return withIds;
    },
    update: async () => [],
  };
}

// Fake Google client: answers by URL shape.
function fakeAuth(log = []) {
  return {
    api: async (tenantId, url, opts = {}) => {
      log.push(url);
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (url.includes('googleAds:search')) {
        const qy = body.query;
        if (/FROM campaign WHERE campaign.id/.test(qy)) return { results: [{ campaign: { id: '11', name: 'Brand', status: 'ENABLED' } }] };
        if (/FROM campaign\b/.test(qy)) return { results: [{ campaign: { id: '11', name: 'Brand', status: 'ENABLED', biddingStrategyType: 'MAXIMIZE_CONVERSIONS' }, campaignBudget: { amountMicros: '20000000', resourceName: 'customers/6424596144/campaignBudgets/1' }, metrics: { costMicros: '150000000', conversions: 4, searchBudgetLostImpressionShare: 0.1 } }] };
        if (/FROM ad_group\b/.test(qy)) return { results: [{ adGroup: { id: '21', name: 'Brand terms', status: 'ENABLED' }, campaign: { id: '11' } }] };
        if (/FROM search_term_view/.test(qy)) return { results: [{ searchTermView: { searchTerm: 'jobpeak' }, campaign: { id: '11' }, metrics: { costMicros: '5000000', clicks: 3, conversions: 1 } }] };
        if (/FROM conversion_action/.test(qy)) return { results: [{ conversionAction: { id: '31', name: 'Sign up', primaryForGoal: true, type: 'WEBPAGE', status: 'ENABLED', origin: 'WEBSITE', category: 'SIGNUP' } }] };
        if (/FROM ad_group_ad/.test(qy)) return { results: [] };
        if (/segments.conversion_action/.test(qy)) return { results: [] };
        if (/customer.descriptive_name/.test(qy)) return { results: [{ customer: { id: '6424596144', descriptiveName: 'JobPeak', currencyCode: 'AED', timeZone: 'Asia/Dubai', status: 'ENABLED' } }] };
        if (/FROM customer/.test(qy)) return { results: [{ customer: { currencyCode: 'AED' }, metrics: { costMicros: '400000000' } }] };
        return { results: [] };
      }
      if (url.includes('analyticsdata')) {
        if (body.dimensions[0].name === 'date') return { rowCount: 2, rows: [{ dimensionValues: [{ value: '20260901' }], metricValues: [{ value: '10' }, { value: '8' }, { value: '30' }, { value: '120' }, { value: '2' }] }, { dimensionValues: [{ value: '20260902' }], metricValues: [{ value: '12' }, { value: '9' }, { value: '35' }, { value: '140' }, { value: '3' }] }] };
        return { rows: [{ dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '65' }, { value: '17' }] }] };
      }
      if (url.includes('analyticsadmin')) {
        if (url.endsWith('/keyEvents')) return { keyEvents: [{ name: 'properties/522078528/keyEvents/1', eventName: 'sign_up', countingMethod: 'ONCE_PER_EVENT' }] };
        if (url.endsWith('/googleAdsLinks')) return { googleAdsLinks: [{ customerId: '6424596144' }] };
        if (url.endsWith('/dataRetentionSettings')) return { eventDataRetention: 'TWO_MONTHS' };
        if (url.endsWith('/dataStreams')) return { dataStreams: [{ type: 'WEB_DATA_STREAM', name: 'properties/522078528/dataStreams/1', webStreamData: { measurementId: 'G-B5KH5C2T8R' } }] };
        if (url.endsWith('/enhancedMeasurementSettings')) return { streamEnabled: true, scrollsEnabled: true };
        if (url.endsWith('/attributionSettings')) return { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN' };
        if (/properties\/\d+$/.test(url)) return { displayName: 'Jobpeak', timeZone: 'Asia/Dubai', currencyCode: 'AED' };
        return {};
      }
      if (url.includes('tagmanager')) {
        if (url.endsWith('/workspaces')) return { workspace: [{ path: 'accounts/6335864759/containers/241680754/workspaces/5', workspaceId: '5', name: 'Default Workspace' }] };
        if (url.endsWith('/tags')) return { tag: [{ tagId: '7', name: 'GA4 config', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ key: 'tagId', value: 'G-B5KH5C2T8R' }] }] };
        if (url.endsWith('/triggers')) return { trigger: [{ triggerId: '9', name: 'Form submit', type: 'formSubmission' }] };
        if (url.endsWith('/version_headers')) return { containerVersionHeader: [{ containerVersionId: '4' }, { containerVersionId: '3' }] };
        if (/\/versions\/\d+$/.test(url)) return { containerVersionId: url.slice(-1), fingerprint: '1756800000000', tag: [] };
        if (url.endsWith('/variables')) return { variable: [{ variableId: '3', name: 'Page path', type: 'v' }] };
        if (url.endsWith('/built_in_variables')) return { builtInVariable: [{ name: 'Page URL', type: 'pageUrl' }] };
        if (/workspaces\/5$/.test(url)) return { name: 'Default Workspace' };
        if (/containers\/241680754$/.test(url)) return { name: 'www.jobpeak.net', usageContext: ['web'] };
        if (/accounts\/6335864759$/.test(url)) return { name: 'Job Peak' };
        return {};
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

test('ads view: account, campaigns with ad groups, conversion actions, search terms', async () => {
  const db = fakeDb();
  const c = createConnected({ db, auth: fakeAuth(), developerToken: 'dev', now: () => 1_756_900_000_000 });
  const v = await c.adsView(TENANT);
  assert.equal(v.linked, true);
  assert.equal(v.scope, 'https://www.googleapis.com/auth/adwords');
  assert.equal(v.account.customer_id_display, '642-459-6144');
  assert.equal(v.account.name, 'JobPeak');
  assert.equal(v.account.currency_code, 'AED');
  assert.equal(v.campaigns.length, 1);
  assert.equal(v.campaigns[0].name, 'Brand');
  assert.equal(v.campaigns[0].budget_daily, 20);
  assert.equal(v.campaigns[0].ad_groups[0].name, 'Brand terms');
  assert.equal(v.conversion_actions[0].name, 'Sign up');
  assert.equal(v.search_terms[0].term, 'jobpeak');
});

test('ads view without a linked account says so instead of erroring', async () => {
  const db = fakeDb();
  db.select = async (table, query, opts) => (table === 'assets' ? (opts && opts.single ? null : []) : null);
  const c = createConnected({ db, auth: fakeAuth(), developerToken: 'dev' });
  const v = await c.adsView(TENANT);
  assert.equal(v.linked, false);
  assert.match(v.reason, /No Google Ads account/);
});

test('pause campaign: synthetic finding + APPROVED change row, approvals + ledger lines', async () => {
  const db = fakeDb();
  const c = createConnected({ db, auth: fakeAuth(), developerToken: 'dev', now: () => 1_756_900_000_000 });
  const r = await c.pauseCampaign(TENANT, '11');
  assert.equal(r.ok, true);
  assert.equal(db.inserted.findings.length, 1);
  assert.equal(db.inserted.findings[0].rule_id, 'user.connected_action');
  assert.equal(db.inserted.findings[0].run_id, 'run1');
  const ch = db.inserted.changes[0];
  assert.equal(ch.tool_id, 'ads.pause_campaign');
  assert.equal(ch.status, 'approved');
  assert.equal(ch.actor, 'user');
  assert.equal(ch.category, 'connected_data');
  assert.deepEqual(ch.params, { campaign_id: '11' });
  assert.equal(ch.finding_id, db.inserted.findings[0].id);
  assert.match(ch.idempotency_key, /^connected:ads\.pause_campaign:campaign:11:status:\d+$/);
  assert.equal(db.inserted.approvals.length, 1);
  assert.equal(db.inserted.ledger[0].event, 'approval');
});

test('exclude searches: cleaned, de-duplicated exact-match negatives, capped at 25', async () => {
  const db = fakeDb();
  const c = createConnected({ db, auth: fakeAuth(), developerToken: 'dev' });
  const many = Array.from({ length: 30 }, (_, i) => `term ${i}`);
  const r = await c.addNegatives(TENANT, '11', [' Free  Course ', 'free course', 'jobs near me', ...many]);
  assert.equal(r.ok, true);
  const ch = db.inserted.changes[0];
  assert.equal(ch.tool_id, 'ads.add_negative_keywords');
  assert.equal(ch.params.campaign_id, '11');
  assert.equal(ch.params.terms.length, 25);
  assert.deepEqual(ch.params.terms[0], { text: 'free course', match_type: 'exact' });
  assert.deepEqual(ch.params.terms[1], { text: 'jobs near me', match_type: 'exact' });
  const empty = await c.addNegatives(TENANT, '11', '   ');
  assert.match(empty.error, /at least one search term/);
});

test('ga4 view + csv export', async () => {
  const db = fakeDb();
  const c = createConnected({ db, auth: fakeAuth(), now: () => 1_756_900_000_000 });
  const v = await c.ga4View(TENANT);
  assert.equal(v.scope, 'https://www.googleapis.com/auth/analytics.readonly');
  assert.equal(v.property.id, '522078528');
  assert.equal(v.property.name, 'Jobpeak');
  assert.deepEqual(v.property.measurement_ids, ['G-B5KH5C2T8R']);
  assert.equal(v.property.retention_months, 2);
  assert.equal(v.report.rows.length, 2);
  assert.equal(v.report.rows[0].date, '2026-09-01');
  assert.deepEqual(v.report.totals, { sessions: 22, users: 17, page_views: 65, events: 260, key_events: 5 });
  assert.equal(v.report.events[0].event_name, 'page_view');
  const csv = await c.ga4Csv(TENANT);
  assert.match(csv.filename, /^insyt-analytics-522078528-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = csv.body.trim().split('\n');
  assert.equal(lines[0], 'date,sessions,users,page_views,events,key_events');
  assert.equal(lines[1], '2026-09-01,10,8,30,120,2');
  assert.equal(lines[3], 'total,22,17,65,260,5');
  assert.equal(lines[5], 'event_name,event_count,users');
  assert.equal(lines[6], 'page_view,65,17');
});

test('gtm view: account → container → workspace, tags with trigger names, triggers, variables', async () => {
  const db = fakeDb();
  const c = createConnected({ db, auth: fakeAuth() });
  const v = await c.gtmView(TENANT);
  assert.equal(v.scope, 'https://www.googleapis.com/auth/tagmanager.readonly');
  assert.equal(v.container.public_id, 'GTM-KR92FJZS');
  assert.equal(v.container.name, 'www.jobpeak.net');
  assert.equal(v.workspace.name, 'Default Workspace');
  assert.equal(v.tags[0].name, 'GA4 config');
  assert.equal(v.tags[0].measurement_id, 'G-B5KH5C2T8R');
  assert.equal(v.triggers[0].name, 'Form submit');
  assert.equal(v.variables[0].name, 'Page path');
  assert.equal(v.built_in_variables[0].name, 'Page URL');
  assert.equal(v.versions.latest.version_id, 4);
});

test('http handler: routes, csv headers, 404, unconfigured 503', async () => {
  const db = fakeDb();
  const c = createConnected({ db, auth: fakeAuth(), developerToken: 'dev' });
  const call = async (method, sub, body) => {
    const chunks = [];
    const res = { writeHead: (code, headers) => { res.code = code; res.headers = headers; }, end: (b) => { chunks.push(b || ''); } };
    const req = { method, on: (ev, fn) => { if (ev === 'data' && body) fn(JSON.stringify(body)); if (ev === 'end') fn(); } };
    await c.handle(req, res, sub, TENANT);
    return { code: res.code, headers: res.headers, body: chunks.join('') };
  };
  const ads = await call('GET', '/ads');
  assert.equal(ads.code, 200);
  assert.equal(JSON.parse(ads.body).account.name, 'JobPeak');
  const csv = await call('GET', '/ga4.csv');
  assert.equal(csv.code, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.headers['content-disposition'], /attachment; filename="insyt-analytics-/);
  const pause = await call('POST', '/ads/campaigns/11/pause');
  assert.equal(pause.code, 200);
  assert.equal(JSON.parse(pause.body).change.tool_id, 'ads.pause_campaign');
  const neg = await call('POST', '/ads/campaigns/11/negatives', { terms: ['free course'] });
  assert.equal(neg.code, 200);
  const bad = await call('POST', '/ads/campaigns/11/negatives', { terms: [] });
  assert.equal(bad.code, 400);
  const nf = await call('GET', '/nope');
  assert.equal(nf.code, 404);
  const off = createConnected({ db, auth: null });
  const chunks = [];
  const res = { writeHead: (code) => { res.code = code; }, end: (b) => chunks.push(b) };
  await off.handle({ method: 'GET', on: () => {} }, res, '/ads', TENANT);
  assert.equal(res.code, 503);
});
