const assert = require('node:assert');
const { test } = require('node:test');
const loops = require('../src/loops');
const gov = require('../src/governance');
const { runLearningJob } = require('../src/job');
const { renderReview } = require('../src/review');

const N = 25;
const tenants = Array.from({ length: N }, (_, i) => `t${i}`);

test('loop 1: min-N gates every pattern; inconclusive-heavy watches propose longer windows; regressions propose tighter thresholds; anomaly periods excluded', () => {
  const mk = (outcome, i, extra = {}) => ({ tenant_id: tenants[i % N], outcome, schedule: { kind: 'negatives' }, effect: { conversions_delta_pct: 5, spend_delta_pct: -12 }, closed_at: '2026-08-10T00:00:00Z', ...extra });
  const few = loops.interventionOutcomes({ watches: Array.from({ length: 10 }, (_, i) => mk('inconclusive', i)) });
  assert.strictEqual(few.proposals.length, 0, 'below min-N nothing is proposed');
  const many = loops.interventionOutcomes({ watches: Array.from({ length: 30 }, (_, i) => mk(i < 18 ? 'inconclusive' : 'verified', i)) });
  assert.ok(many.proposals.some((p) => p.target === 'watch_duration' && p.key === 'negatives'));
  const regress = loops.interventionOutcomes({ watches: Array.from({ length: 30 }, (_, i) => mk(i < 8 ? 'regressed' : 'verified', i)) });
  assert.ok(regress.proposals.some((p) => p.target === 'rule_threshold' && p.to === 'tighten'));
  assert.ok(regress.proposals.some((p) => p.target === 'money_prior'), 'verified-heavy negatives get a measured money prior');
  const excluded = loops.interventionOutcomes({ watches: Array.from({ length: 30 }, (_, i) => mk('regressed', i, { closed_at: '2026-03-15T00:00:00Z' })), anomalies: [{ tenant_id: null, starts_on: '2026-03-01', ends_on: '2026-03-30', label: 'Ramadan' }] });
  assert.strictEqual(excluded.metrics.length, 0, 'market-level anomaly period excluded');
});

test('loop 2: dismissal reasons separate "finding wrong" (threshold) from "explanation failed" (copy); exceptions indict rules', () => {
  const changes = Array.from({ length: 30 }, (_, i) => ({ rule_id: 'ads.wasted_terms', status: i < 20 ? 'failed' : 'applied' }));
  const wrong = loops.humanJudgment({ changes, dismissals: Array.from({ length: 20 }, () => ({ rule_id: 'ads.wasted_terms', reason_tap: 'wrong', expanded_first: true })) });
  assert.ok(wrong.proposals.some((p) => p.target === 'rule_threshold' && p.to === 'raise'));
  const copy = loops.humanJudgment({ changes, dismissals: Array.from({ length: 20 }, () => ({ rule_id: 'ads.wasted_terms', reason_tap: null, expanded_first: false })) });
  assert.ok(copy.proposals.some((p) => p.target === 'finding_copy'));
  assert.ok(copy.proposals.some((p) => p.target === 'surfacing'));
  const exc = loops.humanJudgment({ exceptions: Array.from({ length: 22 }, (_, i) => ({ tenant_id: tenants[i % N], change_key: `ads.add_negative_keywords:campaign:${i}:negatives:abc` })) });
  assert.ok(exc.proposals.some((p) => p.target === 'rule_review' && p.key === 'ads.add_negative_keywords'));
});

test('loop 3: creative patterns need min-N accounts; BEST-heavy → prefer, LOW-heavy → avoid', () => {
  const snaps = [];
  for (let i = 0; i < 30; i++) snaps.push({ tenant_id: tenants[i % N], text: 'Gel Nails from AED 120', performance_label: i < 15 ? 'BEST' : 'GOOD' });
  for (let i = 0; i < 30; i++) snaps.push({ tenant_id: tenants[i % N], text: 'Book today, limited slots', performance_label: 'LOW' });
  const r = loops.creative({ snapshots: snaps, edits: [{ artifact_id: 'd1:Brand:0' }, { artifact_id: 'd1:Brand:1' }, { artifact_id: 'd2:Gel:0' }] });
  assert.ok(r.proposals.some((p) => p.key === 'price_anchored' && p.to === 'prefer'));
  assert.ok(r.proposals.some((p) => p.key === 'urgency' && p.to === 'avoid'));
  assert.strictEqual(r.metrics.edits.edited, 2, 'edits counted per draft:group, not per line');
});

test('loop 4: unanswered requests cluster into a ranked backlog', () => {
  const rows = [...Array(4).fill({ source: 'chat', text: 'change my ad schedule to weekdays only' }), { source: 'composer', text: 'add a call extension' }];
  const r = loops.assistantSelfReport({ unanswered: rows });
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].evidence.n, 4);
  assert.match(r.proposals[0].rationale, /schedule/);
});

test('loop 5: guide success below 60% with min-N → rewrite; stall gate → investigate', () => {
  const journeys = Array.from({ length: 25 }, (_, i) => ({ tenant_id: tenants[i], gates: { tag: false, billing: true }, tag_install: { guide_platform: 'wix', guide_issued_at: 'x', verified_at: i < 10 ? 'y' : null } }));
  const r = loops.funnel({ events: [{ name: 'screen.view', props: { path: '/app' } }, { name: 'approval.approve' }], journeys });
  assert.ok(r.proposals.some((p) => p.target === 'guide' && p.key === 'wix'));
  assert.ok(r.proposals.some((p) => p.target === 'onboarding' && p.key === 'tag'));
  assert.strictEqual(r.metrics.screens['/app'], 1);
});

test('governance: never-tune list refuses, ≤5 per cycle carries the rest, shadow mode replays evidence, heartbeat flags silent streams, tuning watch opens', () => {
  assert.strictEqual(gov.assertTunable({ target: 'bounds', key: 'budget_floor' }).ok, false);
  assert.strictEqual(gov.assertTunable({ target: 'pricing', key: 'core' }).ok, false);
  assert.strictEqual(gov.assertTunable({ target: 'rule_threshold', key: 'live.tag_alive_critical' }).ok, false);
  assert.strictEqual(gov.assertTunable({ target: 'rule_threshold', key: 'ads.wasted_terms' }).ok, true);
  const many = Array.from({ length: 8 }, (_, i) => ({ target: 'rule_threshold', key: `r${i}`, evidence: { n: i } }));
  const { chosen, carried } = gov.capPerCycle(many);
  assert.deepStrictEqual({ c: chosen.length, k: carried.length, best: chosen[0].key }, { c: 5, k: 3, best: 'r7' });
  const findings = Array.from({ length: 30 }, (_, i) => ({ rule_id: 'ads.dow_waste', status: i % 3 === 0 ? 'approved' : 'dismissed', evidence: { metrics: { day_cpa_usd: 50 + i * 10 } } }));
  const sh = gov.shadowThreshold({ findings, candidate: { rule_id: 'ads.dow_waste', metric: 'day_cpa_usd', op: 'gte', current: 50, proposed: 200 } });
  assert.deepStrictEqual({ n: sh.n, would: sh.would_fire }, { n: 30, would: 15 });
  assert.ok(['candidate_wins', 'incumbent_wins'].includes(sh.verdict));
  const hb = gov.heartbeatCheck([{ stream: 'events', last_write_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }], { now: Date.now() });
  assert.ok(!hb.ok && hb.incidents.some((i) => i.stream === 'spend_daily' && i.why === 'never written'));
  assert.ok(!hb.incidents.some((i) => i.stream === 'events'));
  const w = gov.tuningWatch({ id: 'tl1', proposal: { key: 'x' }, evidence: {} }, '2026-09-01T00:00:00Z');
  assert.strictEqual(w.schedule.until, '2026-10-01T00:00:00.000Z');
});

test('job: pooled learning uses consenting tenants only, records proposals + review, reports incidents', async () => {
  const writes = [];
  const consenting = tenants.slice(0, 22).map((id) => ({ id, benchmark_consent: true }));
  const db = {
    select: async (table) => {
      if (table === 'tenants') return [...consenting, { id: 'nope', benchmark_consent: false }];
      if (table === 'watches') return [...Array.from({ length: 30 }, (_, i) => ({ tenant_id: consenting[i % 22].id, outcome: i < 18 ? 'inconclusive' : 'verified', schedule: { kind: 'budgets' }, effect: {}, closed_at: '2026-08-10T00:00:00Z' })), { tenant_id: 'nope', outcome: 'regressed', schedule: { kind: 'budgets' }, closed_at: '2026-08-10T00:00:00Z' }];
      if (table === 'unanswered_log') return Array(3).fill({ source: 'chat', text: 'schedule ads weekdays only' });
      if (table === 'telemetry_heartbeat') return [{ stream: 'events', last_write_at: new Date().toISOString() }];
      if (table === 'learning_reviews') return null;
      return [];
    },
    insert: async (table, rows) => { writes.push({ table, rows }); },
    upsert: async (table, rows) => { writes.push({ table, rows }); },
  };
  const r = await runLearningJob({ db, month: '2026-09-01', now: Date.parse('2026-09-01T06:00:00Z') });
  assert.strictEqual(r.month, '2026-09-01');
  assert.ok(r.proposals.some((p) => p.target === 'watch_duration' && p.key === 'budgets'));
  assert.ok(r.backlog.length === 1);
  assert.ok(r.incidents.some((i) => i.stream === 'spend_daily'));
  const tl = writes.find((w) => w.table === 'tuning_log');
  assert.ok(tl.rows.every((x) => x.status === 'proposed'));
  const rv = writes.find((w) => w.table === 'learning_reviews');
  assert.match(rv.rows[0].body_md, /Pooled learning from \*\*22\*\* consenting accounts of 23/);
  assert.match(r.review_md, /## Proposed tunings this cycle \(1 of max 5\)/);
  assert.match(r.review_md, /Incidents:/);
});

test('review renders without data', () => {
  const md = renderReview({ month: '2026-09-01', pooledTenants: 0, totalTenants: 0, loops: { l1: { metrics: [] }, l2: { metrics: [] }, l3: { metrics: { patterns: [], edits: { edited: 0 } } }, l4: { metrics: { clusters: [] } }, l5: { metrics: { events: {}, screens: {}, stalls: {}, guides: [] } } }, heartbeat: { ok: true, incidents: [] } });
  assert.match(md, /No tuning cleared the evidence bar/);
});
