const assert = require('node:assert');
const { test } = require('node:test');
const { ROWS, byRule } = require('../src/registry');
const { checkBounds, pairBudgetMoves, BOUNDS } = require('../src/bounds');
const { draftChanges, changeKey } = require('../src/drafts');
const { planWatch, judgeWatch } = require('../src/watches');
const { byId: tools } = require('../../tools/src/catalogue');

const ads = {
  customer_id: '123', spend_30d_usd: 3000, ads_conversions_30d: 40,
  campaigns: [
    { id: '11', name: 'Brand', status: 'enabled', budget_daily_usd: 50, budget_resource: 'customers/123/campaignBudgets/1', spend_30d_usd: 1500, conversions_30d: 30 },
    { id: '22', name: 'Generic', status: 'enabled', budget_daily_usd: 40, budget_resource: 'customers/123/campaignBudgets/2', spend_30d_usd: 1200, conversions_30d: 2 },
    { id: '33', name: 'Tiny', status: 'enabled', budget_daily_usd: 6, budget_resource: 'customers/123/campaignBudgets/3', spend_30d_usd: 100, conversions_30d: 1 },
  ],
  search_terms: [
    { term: 'free nails', campaign_id: '11', spend_90d_usd: 90, conversions_90d: 0 },
    { term: 'nail jobs', campaign_id: '22', spend_90d_usd: 60, conversions_90d: 0 },
    { term: 'gel nails dubai', campaign_id: '11', spend_90d_usd: 400, conversions_90d: 9 },
  ],
  conversion_actions: [{ id: 'a1', name: 'Booking', primary: true }, { id: 'a2', name: 'Booking (GA4)', primary: true }],
};
const finding = (rule_id, entity_key, payload, extra = {}) => ({
  finding_id: `f-${rule_id}-${entity_key}`, rule_id, entity_key, status: 'open', payload, fix: { available: true }, money: { impact_monthly_usd: 50 }, ...extra,
});
const state = { account: { daily_budget_total_usd: 96 }, campaign: (id) => ads.campaigns.find((c) => c.id === String(id)), weekly_budget_delta_pct: 0, converting_terms: new Set(['gel nails dubai']), reverted_30d: 0 };

test('registry: every row points at a real catalogue tool and declares its category/watch', () => {
  for (const r of ROWS) {
    if (r.tool_id) assert.ok(tools[r.tool_id], `${r.rule_id} → unknown tool ${r.tool_id}`);
    assert.ok([null, 'negatives', 'budgets', 'counting'].includes(r.category), r.rule_id);
    assert.strictEqual(typeof r.derive, 'function');
    assert.strictEqual(typeof r.rollback, 'function');
  }
  // §4.3: campaign creation, schedule, geo, bidding-strategy are NEVER autopilot
  for (const r of ROWS) {
    if (['ads.pause_campaign', 'ads.pause_keyword', 'ads.adjust_target'].includes(r.tool_id)) assert.strictEqual(r.category, null, r.rule_id);
  }
});

test('negatives: wasted terms group per campaign, exact match, ≤25, with prose before/after', () => {
  const f = finding('ads.wasted_terms', 'wasted_terms', { entities: [
    { value: 'free nails', spend_usd: 90, campaign_id: '11' }, { value: 'nail jobs', spend_usd: 60, campaign_id: '22' },
    ...Array.from({ length: 30 }, (_, i) => ({ value: `junk ${i}`, spend_usd: 1, campaign_id: '11' })),
  ] });
  const shapes = byRule['ads.wasted_terms'].derive(f, { ads });
  assert.strictEqual(shapes.length, 2);
  const brand = shapes.find((s) => s.params.campaign_id === '11');
  assert.strictEqual(brand.params.terms.length, 25);
  assert.strictEqual(brand.params.terms[0].text, 'free nails'); // highest spend first
  assert.ok(brand.params.terms.every((t) => t.match_type === 'exact'));
  assert.match(brand.before.line, /Brand/);
  const rb = byRule['ads.wasted_terms'].rollback({ params: brand.params, after: { resource_names: ['customers/123/campaignCriteria/11~5'] } });
  assert.strictEqual(rb.tool_id, 'ads.remove_negative_keywords');
  assert.strictEqual(byRule['ads.wasted_terms'].rollback({ params: brand.params, after: {} }), null, 'no resource names → irreversible');
});

test('budgets: ±20% derivation, $5 floor, rollback restores previous', () => {
  const raise = byRule['ads.budget_constrained_winner'].derive(finding('ads.budget_constrained_winner', '11', {}), { ads })[0];
  assert.deepStrictEqual({ n: raise.params.new_daily_usd, p: raise.params.previous_daily_usd, r: raise.params.budget_resource }, { n: 60, p: 50, r: 'customers/123/campaignBudgets/1' });
  const cut = byRule['ads.budget_bleeding_loser'].derive(finding('ads.budget_bleeding_loser', '33', {}), { ads })[0];
  assert.strictEqual(cut.params.new_daily_usd, 5, 'floor at $5');
  const rb = byRule['ads.adjust_budget' === 'x' ? '' : 'ads.budget_constrained_winner'].rollback({ params: raise.params });
  assert.strictEqual(rb.params.new_daily_usd, 50);
  assert.strictEqual(byRule['ads.budget_constrained_winner'].derive(finding('ads.budget_constrained_winner', '99', {}), { ads }).length, 0, 'unknown campaign → nothing');
});

test('bounds: per-change 20%, weekly net 30%, $5 floor, converting-term guard, suspect-heavy pause, counting isolation', () => {
  const ok = { tool_id: 'ads.adjust_budget', category: 'budgets', params: { campaign_id: '11', new_daily_usd: 60 } };
  assert.strictEqual(checkBounds(ok, state), null);
  assert.match(checkBounds({ ...ok, params: { campaign_id: '11', new_daily_usd: 61 } }, state), /exceeds 20%/);
  assert.match(checkBounds({ ...ok, params: { campaign_id: '33', new_daily_usd: 4.8 } }, state), /floor/);
  assert.match(checkBounds(ok, { ...state, weekly_budget_delta_pct: 25 }), /net budget movement/);
  assert.match(checkBounds(ok, { ...state, reverted_30d: 2 }), /suspect-heavy/);
  assert.match(checkBounds(ok, { ...state, same_run: { counting: 1 } }), /never share a run/);
  const neg = { tool_id: 'ads.add_negative_keywords', category: 'negatives', params: { campaign_id: '11', terms: [{ text: 'gel nails dubai', match_type: 'exact' }] } };
  assert.match(checkBounds(neg, state), /converted/);
  assert.match(checkBounds({ ...neg, params: { campaign_id: '11', terms: Array.from({ length: 26 }, (_, i) => ({ text: `t${i}` })) } }, state), /exceeds 25/);
  assert.strictEqual(BOUNDS.budget_floor_daily_usd, 5);
});

test('reallocate-only: a raise is funded only by a cut in the same run', () => {
  const raise = { tool_id: 'ads.adjust_budget', params: { new_daily_usd: 60, previous_daily_usd: 50 } };
  const cut = { tool_id: 'ads.adjust_budget', params: { new_daily_usd: 30, previous_daily_usd: 40 } };
  pairBudgetMoves([raise, cut]);
  assert.deepStrictEqual({ r: raise.funded, c: cut.funded }, { r: true, c: true });
  // partial: cut frees 8, raise wanted 10 → raise shrinks to +8
  const partial = { tool_id: 'ads.adjust_budget', params: { new_daily_usd: 60, previous_daily_usd: 50 }, after: { line: '"Brand" runs on $60 a day (up 20%)' }, summary: 'Raised "Brand" daily budget $50 → $60' };
  pairBudgetMoves([partial, { tool_id: 'ads.adjust_budget', params: { new_daily_usd: 32, previous_daily_usd: 40 } }]);
  assert.deepStrictEqual({ f: partial.funded, n: partial.params.new_daily_usd }, { f: true, n: 58 });
  assert.match(partial.after.line, /\$58 a day \(up 16%, funded by the cut\)/);
  assert.match(partial.summary, /→ \$58$/);
  const lone = { tool_id: 'ads.adjust_budget', params: { new_daily_usd: 60, previous_daily_usd: 50 } };
  pairBudgetMoves([lone]);
  assert.strictEqual(lone.funded, false);
});

test('draft_pass: autopilot only within category consent + bounds; dedup vs inflight/recent/exceptions; suspect never re-proposed', () => {
  const findings = [
    finding('ads.wasted_terms', 'wasted_terms', { entities: [{ value: 'free nails', spend_usd: 90, campaign_id: '11' }] }),
    finding('ads.budget_constrained_winner', '11', {}),
    finding('ads.budget_bleeding_loser', '22', {}),
    finding('ads.dual_primary', 'dual', { entities: [{ value: 'Booking' }, { value: 'Booking (GA4)' }] }),
    finding('ads.tcpa_blind', '22', {}),
    finding('ads.wasted_terms', 'suspect_one', { entities: [{ value: 'nail jobs', spend_usd: 60, campaign_id: '22' }] }, { status: 'suspect' }),
  ];
  const { drafts, skipped } = draftChanges({ findings, ctx: { ads }, state, autopilot: { negatives: true, budgets: true, counting: true } });
  const by = Object.fromEntries(drafts.map((d) => [d.rule_id, d]));
  assert.strictEqual(by['ads.wasted_terms'].mode, 'autopilot');
  assert.strictEqual(by['ads.budget_constrained_winner'].mode, 'autopilot', 'raise funded by the cut in the same run');
  assert.strictEqual(by['ads.budget_bleeding_loser'].mode, 'autopilot');
  // counting never shares a run with budgets (attribution clarity) → ask
  assert.strictEqual(by['ads.dual_primary'].mode, 'ask');
  assert.match(by['ads.dual_primary'].reason, /never share a run/);
  assert.strictEqual(by['ads.tcpa_blind'].mode, 'ask');
  assert.strictEqual(by['ads.tcpa_blind'].reason, 'always asks');
  assert.ok(skipped.some((k) => /suspect/.test(k.reason)));
  assert.ok(drafts.every((d) => d.change_key && d.target && d.before.line && d.after.line && d.summary));

  // consent off → ask
  const off = draftChanges({ findings: findings.slice(0, 1), ctx: { ads }, state, autopilot: { negatives: false } });
  assert.strictEqual(off.drafts[0].mode, 'ask');
  assert.strictEqual(off.drafts[0].reason, 'autopilot off for this category');

  // lone raise → ask (reallocate-only)
  const lone = draftChanges({ findings: [findings[1]], ctx: { ads }, state, autopilot: { budgets: true } });
  assert.match(lone.drafts[0].reason, /explicit yes/);

  // dedup
  const key = by['ads.wasted_terms'].change_key;
  assert.strictEqual(draftChanges({ findings: findings.slice(0, 1), ctx: { ads }, state, recent: new Set([key]) }).drafts.length, 0);
  assert.strictEqual(draftChanges({ findings: findings.slice(0, 1), ctx: { ads }, state, exceptions: new Set([key]) }).drafts.length, 0);
  assert.strictEqual(draftChanges({ findings: findings.slice(0, 1), ctx: { ads }, state, inflight: new Set(['campaign:11:negatives']) }).drafts.length, 0);

  // suspect-heavy account: everything becomes ask with the reason (engine paused)
  const heavy = draftChanges({ findings: findings.slice(0, 1), ctx: { ads }, state: { ...state, reverted_30d: 2 }, autopilot: { negatives: true } });
  assert.strictEqual(heavy.drafts[0].mode, 'ask');
  assert.match(heavy.drafts[0].reason, /suspect-heavy/);
});

test('changeKey is canonical: param order does not matter', () => {
  assert.strictEqual(changeKey('t', 'x', { a: 1, b: 2 }), changeKey('t', 'x', { b: 2, a: 1 }));
});

test('watches: plan durations per kind; judge verified/inconclusive/regressed with effect sizes; tracking breakage flagged', () => {
  const w = planWatch({ id: 'c1', tool_id: 'ads.add_negative_keywords', category: 'negatives', watch: { kind: 'negatives', days: 7 }, baseline: { x: 1 } }, '2026-08-01T00:00:00Z');
  assert.strictEqual(w.schedule.until, '2026-08-08T00:00:00.000Z');
  assert.strictEqual(w.kind, 'change_verify');

  const neg = judgeWatch({ kind: 'negatives', window: { days: 7, spend_usd: 500, conversions: 12, prior: { spend_usd: 520, conversions: 11 }, blocked_terms_spend_usd: 0 } });
  assert.strictEqual(neg.outcome, 'verified');
  assert.strictEqual(neg.effect.conversions_delta_pct, 9);
  const negBad = judgeWatch({ kind: 'negatives', window: { days: 7, spend_usd: 500, conversions: 4, prior: { spend_usd: 520, conversions: 11 }, blocked_terms_spend_usd: 0 } });
  assert.strictEqual(negBad.outcome, 'regressed');

  const b = judgeWatch({ kind: 'budgets', baseline: { cpa_30d_usd: 50, conversions_30d: 30 }, window: { days: 14, spend_usd: 900, conversions: 20, prior: { spend_usd: 800, conversions: 18 }, campaign: { spend_usd: 600, conversions: 12 } } });
  assert.strictEqual(b.outcome, 'verified');
  const bBad = judgeWatch({ kind: 'budgets', baseline: { cpa_30d_usd: 50, conversions_30d: 30 }, window: { days: 14, spend_usd: 900, conversions: 20, prior: { spend_usd: 800, conversions: 18 }, campaign: { spend_usd: 600, conversions: 5 } } });
  assert.strictEqual(bBad.outcome, 'regressed');
  assert.strictEqual(bBad.effect.campaign.cpa_usd, 120);

  const c = judgeWatch({ kind: 'counting', window: { days: 2, spend_usd: 100, conversions: 0, prior: { spend_usd: 100, conversions: 5 } } });
  assert.deepStrictEqual({ o: c.outcome, t: c.tracking_breakage }, { o: 'regressed', t: true });
  const thin = judgeWatch({ kind: 'counting', window: { days: 2, spend_usd: 10, conversions: 1, prior: { spend_usd: 10, conversions: 1 } } });
  assert.strictEqual(thin.outcome, 'inconclusive');
  assert.strictEqual(judgeWatch({ kind: 'budgets', window: null }).outcome, 'inconclusive');
});

test('watch.change_regressed row proposes the rollback as an ask-first card', () => {
  const f = { finding_id: 'f9', rule_id: 'watch.change_regressed', entity_key: 'change:c1', status: 'open', fix: { available: true },
    payload: { change_id: 'c1', rollback: { tool_id: 'ads.remove_negative_keywords', params: { campaign_id: '11', resource_names: ['customers/123/campaignCriteria/11~5'] }, target: 'campaign:11:negatives' }, summary: 'Undid: exclusions' } };
  const { drafts } = draftChanges({ findings: [f], ctx: { ads }, state, autopilot: { negatives: true } });
  assert.strictEqual(drafts.length, 1);
  assert.deepStrictEqual({ mode: drafts[0].mode, tool: drafts[0].tool_id, reverts: drafts[0].reverts_change_id }, { mode: 'ask', tool: 'ads.remove_negative_keywords', reverts: 'c1' });
});

test('rollback tools: remove_negative_keywords and enable_keyword only touch what we created', () => {
  const rm = tools['ads.remove_negative_keywords'];
  assert.strictEqual(rm.guard({ campaign_id: '11', resource_names: ['customers/123/campaignCriteria/11~5'] }, { negativesByUs: new Set(['customers/123/campaignCriteria/11~5']) }), null);
  assert.match(rm.guard({ campaign_id: '11', resource_names: ['customers/123/campaignCriteria/11~6'] }, { negativesByUs: new Set() }), /only negatives we added/);
  assert.match(rm.guard({ campaign_id: '11', resource_names: ['nope'] }, {}), /not a campaign criterion/);
  const en = tools['ads.enable_keyword'];
  assert.strictEqual(en.guard({ ad_group_id: '1', criterion_id: '2' }, { pausedKeywordsByUs: new Set(['1~2']) }), null);
  assert.match(en.guard({ ad_group_id: '1', criterion_id: '3' }, { pausedKeywordsByUs: new Set(['1~2']) }), /we paused/);
});
