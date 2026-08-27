const assert = require('node:assert');
const { test } = require('node:test');
const { buildCampaignSpec, sourceKeywords } = require('../src/builder');
const { planMutations, createCampaignPaused, stripMatch } = require('../src/executor');
const { validateCopy, draftCopy, policyScreen, diffCopy } = require('../src/copy');
const { createDraftService } = require('../src/service');

const spec = buildCampaignSpec({ template: 'generic', business: 'The Nail DXB', services: ['Gel nails'], location: 'Dubai', budget_daily_usd: 25, final_url: 'https://thenaildxb.com/' });

test('executor plan: budget+campaign PAUSED atomic, geo/language criteria, negatives phrase, keywords exact/phrase only, RSA with pins', () => {
  const plan = planMutations(spec, { customerId: '123-456-7890', finalUrl: spec.final_url, geoTargetIds: ['1000013'] });
  const camp = plan.campaignOps.find((o) => o.campaignOperation).campaignOperation.create;
  assert.deepStrictEqual({ st: camp.status, ch: camp.advertisingChannelType, bid: 'maximizeConversions' in camp, partner: camp.networkSettings.targetPartnerSearchNetwork }, { st: 'PAUSED', ch: 'SEARCH', bid: true, partner: false });
  assert.strictEqual(plan.campaignOps.filter((o) => o.campaignCriterionOperation).length, 2); // geo + language
  assert.ok(plan.negatives.includes('free') && plan.negatives.includes('jobs'));
  const kw = plan.keywordOps('customers/1234567890/adGroups/9', spec.ad_groups[0]);
  assert.ok(kw.every((k) => ['EXACT', 'PHRASE'].includes(k.create.keyword.matchType)));
  assert.strictEqual(kw[0].create.keyword.text, 'gel nails dubai');
  const ad = plan.adOps('customers/1234567890/adGroups/9', spec.ad_groups[0])[0].create;
  assert.deepStrictEqual(ad.ad.finalUrls, ['https://thenaildxb.com/']);
  assert.ok(ad.ad.responsiveSearchAd.headlines.length >= 8);
  assert.throws(() => planMutations({ ...spec, settings: { ...spec.settings, start_paused: false } }, { customerId: '1', finalUrl: 'https://x.com' }), /ALWAYS created paused/);
  assert.throws(() => planMutations(spec, { customerId: '1', finalUrl: 'thenaildxb.com' }), /http/);
  assert.throws(() => planMutations({ ...spec, ad_groups: [{ ...spec.ad_groups[0], keywords: [{ text: 'nails', match: 'broad' }] }] }, { customerId: '1', finalUrl: 'https://x.com' }).keywordOps('ag', { ...spec.ad_groups[0], keywords: [{ text: 'nails', match: 'broad' }] }), /broad match/);
  assert.strictEqual(stripMatch('[gel nails]'), 'gel nails');
});

test('createCampaignPaused: sequences mutates and returns every resource; unresolved geo is a warning, not a failure', async () => {
  const calls = [];
  const adsMutate = async (path, ops, opts) => {
    calls.push({ path, n: ops.length, opts });
    if (path === 'googleAds') return { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/1/campaignBudgets/5' } }, { campaignResult: { resourceName: 'customers/1/campaigns/77' } }] };
    return { results: ops.map((_, i) => ({ resourceName: `customers/1/${path}/${i}` })) };
  };
  const r = await createCampaignPaused({ spec, adsMutate, adsSearch: async () => [], customerId: '1', finalUrl: spec.final_url });
  assert.strictEqual(r.campaign_id, '77');
  assert.deepStrictEqual(calls.map((c) => c.path), ['googleAds', 'campaignCriteria', 'adGroups', 'adGroupCriteria', 'adGroupAds']);
  assert.strictEqual(calls[0].opts.atomic, true);
  assert.strictEqual(r.resources.ad_groups.length, 1);
  assert.ok(r.resources.keywords.length >= 3 && r.resources.ads.length === 1);
  assert.match(r.warnings[0], /Could not resolve "Dubai"/);
});

test('copy validation: lengths, jargon, policy, unwitnessed prices, counts, pins; em dashes normalised', () => {
  const good = { headlines: ['Gel Nails in Dubai', 'Book Gel Nails Today', 'The Nail DXB - Gel Nails', 'See Prices & Availability', 'Rated by Real Customers', 'Fast, Friendly Service', 'Easy Online Booking', 'Gel Nails from AED 120'], descriptions: ['Looking for gel nails in Dubai? Clear prices, real reviews, quick booking.', 'Book online in under a minute.', 'Local and rated by customers like you.'], pinned: { headline_1: 'Gel Nails in Dubai' } };
  const v = validateCopy(good, { witnessedPrices: [120] });
  assert.deepStrictEqual(v.problems, []);
  const bad = validateCopy({ ...good, headlines: [...good.headlines.slice(0, 7), 'The best nails — guaranteed!! Only AED 99'] }, { witnessedPrices: [120] });
  assert.ok(bad.problems.some((p) => /characters/.test(p)) && bad.problems.some((p) => /superlative/.test(p)) && bad.problems.some((p) => /guarantee/.test(p)) && bad.problems.some((p) => /price 99/.test(p)));
  assert.ok(bad.rsa.headlines[7].includes(' - '), 'em dash normalised');
  assert.ok(validateCopy({ ...good, descriptions: ['Boost your conversion rate today.', 'x', 'y'] }).problems.some((p) => /trade vocabulary/.test(p)));
  assert.ok(validateCopy({ ...good, headlines: good.headlines.slice(0, 5) }).problems.some((p) => /at least 8/.test(p)));
  assert.deepStrictEqual(policyScreen('Click here for the #1 salon'), ['unverifiable superlative', 'call-to-click text']);
});

test('draftCopy: model output used when valid, retried once with the problems, builder fallback otherwise (over-length lines dropped)', async () => {
  const fallback = spec.ad_groups[0].rsa;
  const attempts = [];
  const flaky = async ({ prompt }) => {
    attempts.push(prompt);
    if (attempts.length === 1) return JSON.stringify({ headlines: ['Way too long headline text for a google ad here'], descriptions: ['x'] });
    return JSON.stringify({ headlines: ['Gel Nails in Dubai', 'Book Gel Nails Today', 'The Nail DXB Gel Nails', 'Clear Prices, Real Reviews', 'Rated by Real Customers', 'Fast, Friendly Service', 'Easy Online Booking', 'Open Seven Days a Week'], descriptions: ['Gel nails in Dubai with clear prices and real reviews. Book in under a minute.', 'Message us with any question; we reply fast.', 'Local, reliable, rated by customers like you.'] });
  };
  const r = await draftCopy({ business: 'The Nail DXB', service: 'Gel nails', location: 'Dubai', prices: [], generate: flaky, modelId: 'claude-fable-5', fallback });
  assert.deepStrictEqual({ src: r.source, model: r.model_version, tries: attempts.length, rejected: r.rejected.length }, { src: 'model', model: 'claude-fable-5', tries: 2, rejected: 1 });
  assert.match(attempts[1], /Your last draft was rejected/);
  const fb = await draftCopy({ business: 'A Very Long Business Name For Testing Purposes Ltd', fallback: buildCampaignSpec({ template: 'generic', business: 'A Very Long Business Name For Testing Purposes Ltd', services: ['Nails'] }).ad_groups[0].rsa, generate: async () => { throw new Error('down'); } });
  assert.strictEqual(fb.source, 'builder');
  assert.ok(fb.rsa.headlines.every((h) => h.length <= 30));
  const none = await draftCopy({ business: 'X', fallback, generate: null });
  assert.strictEqual(none.source, 'builder');
});

test('diffCopy labels only the changed lines', () => {
  const d = diffCopy({ headlines: ['A', 'B'], descriptions: ['x'] }, { headlines: ['A', 'B2'], descriptions: ['x'] });
  assert.deepStrictEqual(d, [{ kind: 'headline', index: 1, drafted: 'B', shipped: 'B2' }]);
});

test('sourceKeywords: seeds ∪ winners − exceptions/negatives, CPA-gated, inspectable exclusions', () => {
  const r = sourceKeywords({
    business: 'The Nail DXB', services: ['Gel nails'], location: 'Dubai',
    searchTerms: [{ term: 'gel nails dubai marina', conversions_90d: 4, spend_90d_usd: 200 }, { term: 'cheap nails', conversions_90d: 1, spend_90d_usd: 300 }, { term: 'nail course dubai', conversions_90d: 2, spend_90d_usd: 40 }, { term: 'nothing', conversions_90d: 0, spend_90d_usd: 50 }],
    accountMedianCpaUsd: 100, negatives: ['course'],
  });
  assert.ok(r.keywords.some((k) => k.text === '[gel nails dubai marina]' && k.source === 'winner'));
  assert.ok(r.keywords.some((k) => k.text === '"the nail dxb"' && k.source === 'brand'));
  assert.deepStrictEqual(r.excluded.map((e) => e.text).sort(), ['cheap nails', 'nail course dubai']);
  const s2 = buildCampaignSpec({ template: 'generic', business: 'X', services: ['Nails'], sourced_keywords: r.keywords });
  assert.ok(s2.ad_groups[0].keywords.some((k) => k.text === '[gel nails dubai marina]'));
});

// ---- service: gates, staging, provisional vs live create, second yes, edit labels
function fakeDb(state) {
  const writes = [];
  return {
    writes, state,
    select: async (table, query, opts) => {
      if (table === 'tenants') return { id: 't1', name: 'The Nail DXB', website_url: 'https://thenaildxb.com/' };
      if (table === 'campaigns') return [];
      if (table === 'findings') return state.findings || [];
      if (table === 'journey_state') return state.journey || null;
      if (table === 'assets') return state.assets || [{ kind: 'ads_account' }, { kind: 'ga4_property' }, { kind: 'gtm_container' }];
      if (table === 'standing_exceptions') return [];
      if (table === 'campaign_drafts') return state.draft || null;
      return opts && opts.single ? null : [];
    },
    insert: async (table, rows) => { writes.push({ table, rows }); return rows.map((r, i) => ({ id: `${table}-${i}`, ...r })); },
    update: async (table, query, patch) => { writes.push({ table, patch }); if (table === 'campaign_drafts' && state.draft) Object.assign(state.draft, patch); },
    upsert: async (table, rows) => { writes.push({ table, rows }); },
  };
}

test('service.create: sourced keywords + copy source recorded; broken measurement → staged with the §5.1 checklist', async () => {
  const state = { findings: [{ rule_id: 'ads.conversion_silent', layer: 4, severity: 'critical' }], assets: [{ kind: 'ads_account' }], journey: { journey: 'B', gates: { tag: false, billing: false, approval: false } } };
  const db = fakeDb(state);
  const svc = createDraftService({ db, google: { fetchAds: async () => ({ campaigns: [], search_terms: [{ term: 'gel nails dubai', conversions_90d: 3, spend_90d_usd: 90 }] }) }, model: null });
  const row = await svc.create({ tenantId: 't1', template: 'generic', inputs: { services: ['Gel nails'], location: 'Dubai', budget_daily_usd: 20 } });
  assert.strictEqual(row.spec.copy.source, 'builder');
  assert.strictEqual(row.spec.keyword_sourcing.winners, 1);
  assert.strictEqual(row.spec.gates.ok, false);
  assert.ok(row.spec.gates.steps.some((s) => s.key === 'ga4' && s.insyt_does_it));
  state.draft = { id: 'd1', tenant_id: 't1', status: 'draft', spec: row.spec };
  const r = await svc.approve({ tenantId: 't1', draftId: 'd1' });
  assert.strictEqual(r.status, 'staged');
  assert.ok(r.blockers.length >= 1 && r.steps.length >= 3);
  assert.strictEqual(state.draft.status, 'draft', 'staged drafts stay drafts');
});

test('service.approve: live create records resources + change + ledger; enable is a separate call with its own approval', async () => {
  const state = {};
  const db = fakeDb(state);
  const api = {
    'ads.create_campaign_draft': async (p) => ({ before: {}, after: { campaign_id: '77', status: 'paused', resources: { campaign: 'customers/1/campaigns/77' }, warnings: [] } }),
    'ads.unpause_launch': async () => ({ before: { status: 'paused' }, after: { status: 'enabled' } }),
  };
  const svc = createDraftService({ db, google: { transportsFor: async () => api } });
  const row = await svc.create({ tenantId: 't1', template: 'brand', inputs: {} });
  state.draft = { id: 'd2', tenant_id: 't1', status: 'draft', spec: row.spec };
  const a = await svc.approve({ tenantId: 't1', draftId: 'd2', actor: 'user' });
  assert.deepStrictEqual({ st: a.status, id: a.campaign_id }, { st: 'created_paused', id: '77' });
  assert.ok(db.writes.some((w) => w.table === 'changes' && w.rows[0].tool_id === 'ads.create_campaign_draft' && w.rows[0].status === 'applied'));
  assert.ok(db.writes.some((w) => w.table === 'ledger' && /paused/.test(w.rows[0].summary_text)));
  assert.ok(!db.writes.some((w) => w.table === 'approvals'), 'creating never launches');
  state.draft.status = 'created_paused'; state.draft.google_campaign_id = '77';
  const e = await svc.enable({ tenantId: 't1', draftId: 'd2' });
  assert.strictEqual(e.status, 'enabled');
  assert.ok(db.writes.some((w) => w.table === 'approvals' && w.rows[0].scope === 'campaign_launch'));
  assert.ok(db.writes.some((w) => w.table === 'ledger' && w.rows[0].event === 'campaign_launched'));
});

test('service.approve without credentials stays provisional; enable refuses when gates are down', async () => {
  const state = {};
  const db = fakeDb(state);
  const svc = createDraftService({ db });
  const row = await svc.create({ tenantId: 't1', template: 'brand', inputs: {} });
  state.draft = { id: 'd3', tenant_id: 't1', status: 'draft', spec: row.spec };
  const a = await svc.approve({ tenantId: 't1', draftId: 'd3' });
  assert.deepStrictEqual({ st: a.status, prov: a.provisional }, { st: 'created_paused', prov: true });
  state.journey = { journey: 'B', gates: { tag: false, billing: true } };
  state.draft.status = 'created_paused'; state.draft.google_campaign_id = 'draft-d3';
  const e = await svc.enable({ tenantId: 't1', draftId: 'd3' });
  assert.match(e.error, /Tracking and billing/);
});

test('service.edit: validated, diff recorded to draft_edits with the model version', async () => {
  const state = {};
  const db = fakeDb(state);
  const svc = createDraftService({ db });
  const row = await svc.create({ tenantId: 't1', template: 'generic', inputs: { services: ['Gel nails'] } });
  row.spec.copy.model_version = 'claude-fable-5';
  state.draft = { id: 'd4', tenant_id: 't1', status: 'draft', spec: row.spec };
  const g = row.spec.ad_groups[0];
  const edited = { ...g.rsa, headlines: [...g.rsa.headlines.slice(0, 7), 'Walk-ins Welcome Daily'] };
  const r = await svc.edit({ tenantId: 't1', draftId: 'd4', adGroups: [{ name: g.name, rsa: edited }] });
  assert.strictEqual(r.ok, true);
  const de = db.writes.filter((w) => w.table === 'draft_edits');
  assert.strictEqual(de.length, 1);
  assert.deepStrictEqual({ k: de[0].rows[0].artifact_kind, s: de[0].rows[0].shipped, m: de[0].rows[0].model_version }, { k: 'rsa_headline', s: 'Walk-ins Welcome Daily', m: 'claude-fable-5' });
  const bad = await svc.edit({ tenantId: 't1', draftId: 'd4', adGroups: [{ name: g.name, rsa: { ...edited, headlines: ['The best nails guaranteed forever and ever'] } }] });
  assert.match(bad.error, /superlative/);
});
