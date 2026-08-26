const assert = require('node:assert');
const { test } = require('node:test');
const { runPipeline } = require('../src/pipeline');
const { buildStages, stageDataPresent } = require('../src/stages');

function mkStore() {
  const checkpoints = []; const finishes = [];
  return {
    checkpoints, finishes,
    saveCheckpoint: async (id, cp) => checkpoints.push(JSON.parse(JSON.stringify(cp))),
    finishRun: async (id, patch) => finishes.push(patch),
  };
}

test('pipeline: happy path completes, checkpoints after every stage, emits real progress', async () => {
  const store = mkStore();
  const events = [];
  const stages = [
    { name: 'a', run: async () => ({ x: 1 }) },
    { name: 'b', run: async (ctx) => ({ y: ctx.x + 1, _progress: { things: 7 } }) },
  ];
  const r = await runPipeline({ run: { id: 'r1' }, stages, store, emit: (e) => events.push(e) });
  assert.strictEqual(r.status, 'complete');
  assert.strictEqual(r.ctx.y, 2);
  assert.strictEqual(store.checkpoints.length, 2);
  assert.ok(events.some((e) => e.stage === 'b' && e.state === 'done' && e.progress.things === 7));
});

test('pipeline: optional stage fails after retries -> degraded, run continues; required stage fails -> failed', async () => {
  const store = mkStore();
  let tries = 0;
  const stages = [
    { name: 'live_witness', run: async () => { tries += 1; throw new Error('site down'); } },
    { name: 'rules', run: async () => ({ ok: true }) },
  ];
  const r = await runPipeline({ run: { id: 'r1' }, stages, store });
  assert.strictEqual(tries, 3, 'retry x2 then give up');
  assert.strictEqual(r.status, 'degraded');
  assert.match(r.degraded_reasons[0], /live_witness: site down/);
  assert.strictEqual(r.ctx.ok, true, 'later stages still ran');

  const r2 = await runPipeline({
    run: { id: 'r2' },
    stages: [{ name: 'rules_pass', required: true, run: async () => { throw new Error('no data'); } }],
    store: mkStore(),
  });
  assert.strictEqual(r2.status, 'failed');
});

test('pipeline: resume skips completed stages and restores ctx from checkpoint', async () => {
  const store = mkStore();
  let aRuns = 0;
  const stages = [
    { name: 'a', run: async () => { aRuns += 1; return { x: 42 }; } },
    { name: 'b', run: async (ctx) => ({ y: ctx.x * 2 }) },
  ];
  // First run crashes between a and b — simulate by taking a's checkpoint.
  await runPipeline({ run: { id: 'r1' }, stages: [stages[0]], store });
  const resumedCheckpoint = store.checkpoints.at(-1);
  const r = await runPipeline({ run: { id: 'r1', checkpoint: resumedCheckpoint }, stages, store });
  assert.strictEqual(aRuns, 1, 'stage a not re-run on resume');
  assert.strictEqual(r.ctx.y, 84, 'ctx.x restored from checkpoint');
});

test('pipeline: stage timeout is a failure like any other', async () => {
  const r = await runPipeline({
    run: { id: 'r1' },
    stages: [{ name: 'slow', run: () => new Promise(() => {}), timeoutMs: 30 }],
    store: mkStore(),
  });
  assert.strictEqual(r.status, 'degraded');
  assert.match(r.degraded_reasons[0], /timeout/);
});

test('stages: end-to-end §8 run over stub clients produces a stored report', async () => {
  const gtm = {
    container_public_id: 'GTM-TEST123',
    tags: [
      { id: 't1', name: 'GA4', type: 'gaawc', paused: false, measurement_id: 'G-FIXTURE001', trigger_ids: ['1'] },
      { id: 't2', name: 'Old UA', type: 'ua', paused: false, measurement_id: 'UA-1-1', trigger_ids: ['1'] },
    ],
    triggers: [{ id: '1' }], workspace_changes: [], versions: null, publish_dates: [],
  };
  const saved = {};
  const stages = buildStages({
    google: {
      fetchGtmSnapshot: async () => gtm,
      fetchGa4Config: async () => ({ property_id: 'p1', key_events: [{ event_name: 'generate_lead' }], ads_links: [{ customer_id: '1', create_time: '2026-01-01T00:00:00Z' }], retention_months: 14, enhanced_measurement: { enabled: false, events: [] }, attribution: { is_default: true }, measurement_ids: ['G-FIXTURE001'] }),
      fetchGa4Data: async () => ({ window_days: 30, sessions_30d: 900, events: [{ event_name: 'generate_lead', total_30d: 12, daily: [] }] }),
      fetchAds: async () => ({ customer_id: '1', spend_30d_usd: 500, spend_90d_usd: 1500, conversion_actions: [{ id: 'a', name: 'Leads', primary: true, count_30d: 12, last_conversion_at: '2026-08-18T00:00:00Z', source: 'ga4_import', ga4_event_name: 'generate_lead' }], campaigns: [], search_terms: [{ term: 'free stuff', campaign_id: 'c', spend_90d_usd: 200, clicks_90d: 100, conversions_90d: 0 }], disapproved: [], ads_conversions_30d: 12, ga4_key_events_30d: 12 }),
    },
    crawler: { verificationCrawl: async () => ({ pages: [{ url: '/', ok: true, is_homepage: true, gtm_containers_seen: ['GTM-TEST123'], collect_measurement_ids: ['G-FIXTURE001'] }] }) },
    model: { generate: async () => JSON.stringify({ title: 'Plain words', explanation: 'Plain explanation.', exec_summary: 'Summary.', since_last_week: '' }) },
    store: {
      ruleConfig: async () => Object.fromEntries(require('../../../packages/rules/index.js') && [
        ['gtm.legacy_debris', { default_severity: 'warning', thresholds: {}, fix_tool_id: 'gtm.pause_tag', enabled: true }],
        ['ads.wasted_terms', { default_severity: 'warning', thresholds: {}, fix_tool_id: 'ads.add_negative_keywords', enabled: true }],
      ]),
      priorFindings: async () => [],
      ledgerCumulative: async () => null,
      saveFindings: async (runId, f) => { saved.findings = f; },
      saveReport: async (runId, r) => { saved.report = r; },
    },
  });
  const result = await runPipeline({
    run: { id: 'r1', tenant_id: 'tn1', type: 'signup_audit', website_url: 'https://x.com' },
    stages, store: mkStore(),
  });
  assert.strictEqual(result.status, 'complete');
  assert.ok(saved.findings.length >= 2, 'legacy debris + wasted terms found');
  assert.ok(saved.report.html_email.includes('<!doctype html>'));
  assert.ok(!saved.report.html_email.includes('free stuff'), 'blur boundary holds in delivered email');
});

test('stageDataPresent: layers only run when their stage data arrived', () => {
  assert.strictEqual(stageDataPresent({ layer: 4 }, { gtm: {} }), false);
  assert.strictEqual(stageDataPresent({ layer: 4 }, { ads: {} }), true);
  assert.strictEqual(stageDataPresent({ layer: 3 }, { ga4Data: {} }), false, 'layer 3 needs gtm too');
  assert.strictEqual(stageDataPresent({ layer: 3 }, { ga4Data: {}, gtm: {} }), true);
});

test('fetch_ads: deep blocks attach as ads.deep, the snapshot stage persists, and a deep failure degrades quietly', async () => {
  const { runPipeline } = require('../src/pipeline');
  const snapshots = [];
  const mk = (deepImpl) => buildStages({
    google: {
      fetchAds: async () => ({ customer_id: '1', spend_30d_usd: 10, campaigns: [{ id: '11', name: 'Brand', status: 'enabled', budget_daily_usd: 20, bidding: { strategy: 'max_conversions' } }], search_terms: [], conversion_actions: [], disapproved: [] }),
      fetchAdsDeep: deepImpl,
    },
    crawler: {}, model: {},
    store: { saveSnapshots: async (tenantId, ads, runId) => { snapshots.push({ tenantId, ads, runId }); return { campaigns: ads.campaigns.length }; } },
  });
  const pick = (stages) => stages.filter((s) => s.name === 'fetch_ads' || s.name === 'snapshot');
  const events = [];
  const ok = await runPipeline({ run: { id: 'r1', tenant_id: 'tn1' }, stages: pick(mk(async () => ({ hours: [], daily: [{ date: '2026-08-01', cost_usd: 1, conversions: 0 }], currency_code: 'AED', blocks: { hours: { status: 'measured' }, daily: { status: 'measured' } } }))), store: mkStore(), emit: (e) => events.push(e) });
  assert.strictEqual(ok.status, 'complete');
  assert.strictEqual(ok.ctx.ads.currency, 'AED');
  assert.strictEqual(ok.ctx.ads.deep.daily.length, 1);
  assert.strictEqual(snapshots[0].runId, 'r1');
  const fetched = events.find((e) => e.stage === 'fetch_ads' && e.state === 'done');
  assert.strictEqual(fetched.progress.deep_blocks_measured, 2);

  const bad = await runPipeline({ run: { id: 'r2', tenant_id: 'tn1' }, stages: pick(mk(async () => { throw new Error('PERMISSION_DENIED'); })), store: mkStore() });
  assert.strictEqual(bad.status, 'complete', 'deep failure never fails the ads stage');
  assert.strictEqual(bad.ctx.ads.deep, undefined);
});
