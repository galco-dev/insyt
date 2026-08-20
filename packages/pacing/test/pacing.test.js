// Pacing math — the daily "will anything blow its budget?" answer.
const assert = require('node:assert');
const { test } = require('node:test');
const { pace, sortPacing, targetStatus, daysInMonth } = require('../src/pacing');

test('daysInMonth handles 31/30/28/29', () => {
  assert.strictEqual(daysInMonth('2026-08-20'), 31);
  assert.strictEqual(daysInMonth('2026-09-01'), 30);
  assert.strictEqual(daysInMonth('2026-02-10'), 28);
  assert.strictEqual(daysInMonth('2028-02-10'), 29); // leap
});

test('pace: on-pace account projects to budget', () => {
  // Day 20 of 31, $2000 budget → expected ≈ $1290.32; spend right on it.
  const p = pace({ monthlyBudgetUsd: 2000, mtdSpendUsd: 1290.32, nowIso: '2026-08-20T09:00:00Z' });
  assert.strictEqual(p.status, 'on_pace');
  assert.strictEqual(p.dayOfMonth, 20);
  assert.strictEqual(p.daysInMonth, 31);
  assert.strictEqual(p.expectedToDate, 1290.32);
  assert.ok(Math.abs(p.projected - 2000) < 1);
});

test('pace: over / under thresholds at +10% and −20%', () => {
  const over = pace({ monthlyBudgetUsd: 1000, mtdSpendUsd: 720, nowIso: '2026-08-20T00:00:00Z' });
  // projected = 720/20*31 = 1116 → +11.6%
  assert.strictEqual(over.status, 'over');
  assert.strictEqual(over.deltaPct, 11.6);

  const under = pace({ monthlyBudgetUsd: 1000, mtdSpendUsd: 500, nowIso: '2026-08-20T00:00:00Z' });
  // projected = 775 → −22.5%
  assert.strictEqual(under.status, 'under');

  const fine = pace({ monthlyBudgetUsd: 1000, mtdSpendUsd: 640, nowIso: '2026-08-20T00:00:00Z' });
  // projected = 992 → −0.8%
  assert.strictEqual(fine.status, 'on_pace');
});

test('pace: at_risk when month-to-date looks fine but last 7 days accelerate', () => {
  // MTD on pace, but last-7 run rate projects +24% over.
  const p = pace({ monthlyBudgetUsd: 3100, mtdSpendUsd: 2000, last7SpendUsd: 868, nowIso: '2026-08-20T00:00:00Z' });
  assert.strictEqual(p.status, 'at_risk');
  // Same recent spend but early in month (< day 8) never flags acceleration.
  const early = pace({ monthlyBudgetUsd: 3100, mtdSpendUsd: 700, last7SpendUsd: 868, nowIso: '2026-08-07T00:00:00Z' });
  assert.notStrictEqual(early.status, 'at_risk');
});

test('pace: no budget set surfaces as no_budget', () => {
  const p = pace({ monthlyBudgetUsd: null, mtdSpendUsd: 400, nowIso: '2026-08-20T00:00:00Z' });
  assert.strictEqual(p.status, 'no_budget');
  assert.strictEqual(p.projected, null);
});

test('sortPacing: over first, then at_risk/under/no_budget, biggest delta first within band', () => {
  const rows = [
    { id: 'a', pacing: { status: 'on_pace', deltaPct: 1 } },
    { id: 'b', pacing: { status: 'over', deltaPct: 12 } },
    { id: 'c', pacing: { status: 'over', deltaPct: 31 } },
    { id: 'd', pacing: { status: 'no_budget', deltaPct: null } },
    { id: 'e', pacing: { status: 'under', deltaPct: -25 } },
  ];
  assert.deepStrictEqual(sortPacing(rows).map((r) => r.id), ['c', 'b', 'e', 'd', 'a']);
});

test('targetStatus: CPA and ROAS with 10% tolerance; no_target passthrough', () => {
  // CPA $50 vs target $45 → within 10% tolerance (49.5? no: 45*1.1=49.5; 50>49.5 → missing)
  const miss = targetStatus({ cpaTargetUsd: 45, spendUsd: 500, conversions: 10 });
  assert.strictEqual(miss.cpa, 50);
  assert.strictEqual(miss.status, 'missing');
  const hit = targetStatus({ cpaTargetUsd: 45, spendUsd: 490, conversions: 10 });
  assert.strictEqual(hit.status, 'hitting');

  const roasHit = targetStatus({ roasTarget: 4, spendUsd: 1000, conversionValueUsd: 3700 });
  assert.strictEqual(roasHit.roas, 3.7);
  assert.strictEqual(roasHit.status, 'hitting'); // 3.7 ≥ 4*0.9
  const roasMiss = targetStatus({ roasTarget: 4, spendUsd: 1000, conversionValueUsd: 3400 });
  assert.strictEqual(roasMiss.status, 'missing');

  assert.strictEqual(targetStatus({ spendUsd: 100, conversions: 2 }).status, 'no_target');
  // Target set but zero conversions yet = missing, not unknown.
  assert.strictEqual(targetStatus({ cpaTargetUsd: 40, spendUsd: 200, conversions: 0 }).status, 'missing');
});
