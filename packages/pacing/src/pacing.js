// Budget pacing math — pure functions, injected time. The daily agency ritual
// ("is anything going to blow its budget?") reduced to one sorted list.
//
// Model: an account paces against its monthly media budget (account_targets.
// monthly_budget_usd). Spend comes from spend_daily snapshots — month-to-date
// sum. Projection is a simple run rate over elapsed days: agencies think in
// run rate, and a fancier model would be false precision on snapshot data.
//
// Status bands (deltaPct = projected vs budget):
//   over       ≥ +10% — projected to overspend meaningfully
//   under      ≤ −20% — leaving budget (and volume) on the table
//   at_risk    within ±band but > +10% pace in the last 7 days (accelerating)
//   on_pace    otherwise
// no_budget: target not set — surfaced first so it gets set.

function daysInMonth(iso) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * pace({ monthlyBudgetUsd, mtdSpendUsd, last7SpendUsd, nowIso })
 * -> { budget, mtd, dayOfMonth, daysInMonth, expectedToDate, projected,
 *      deltaPct, status }
 */
function pace({ monthlyBudgetUsd, mtdSpendUsd, last7SpendUsd = null, nowIso }) {
  const dim = daysInMonth(nowIso);
  const day = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`).getUTCDate();
  const mtd = Math.round((mtdSpendUsd || 0) * 100) / 100;

  if (!monthlyBudgetUsd || monthlyBudgetUsd <= 0) {
    return { budget: null, mtd, dayOfMonth: day, daysInMonth: dim, expectedToDate: null, projected: null, deltaPct: null, status: 'no_budget' };
  }

  const budget = monthlyBudgetUsd;
  const expectedToDate = Math.round((budget * (day / dim)) * 100) / 100;
  const projected = Math.round((day > 0 ? (mtd / day) * dim : 0) * 100) / 100;
  const deltaPct = Math.round(((projected - budget) / budget) * 1000) / 10;

  let status = 'on_pace';
  if (deltaPct >= 10) status = 'over';
  else if (deltaPct <= -20) status = 'under';
  else if (last7SpendUsd != null && day > 7) {
    // Acceleration check: last-7-day run rate projected forward.
    const recentProjected = (last7SpendUsd / 7) * dim;
    if ((recentProjected - budget) / budget >= 0.10) status = 'at_risk';
  }
  return { budget, mtd, dayOfMonth: day, daysInMonth: dim, expectedToDate, projected, deltaPct, status };
}

// Sort order for the pacing screen: problems first, biggest overspend first,
// then missing budgets (they need a target set), then the healthy tail.
const STATUS_RANK = { over: 0, at_risk: 1, under: 2, no_budget: 3, on_pace: 4 };
function sortPacing(rows) {
  return rows.slice().sort((a, b) => {
    const r = (STATUS_RANK[a.pacing.status] ?? 9) - (STATUS_RANK[b.pacing.status] ?? 9);
    if (r !== 0) return r;
    return Math.abs(b.pacing.deltaPct || 0) - Math.abs(a.pacing.deltaPct || 0);
  });
}

// Target performance: actual CPA/ROAS vs the agency's own targets.
// status: hitting | missing | no_target. A target is "missing" beyond 10%
// tolerance in the bad direction (CPA above, ROAS below).
function targetStatus({ cpaTargetUsd = null, roasTarget = null, spendUsd = 0, conversions = 0, conversionValueUsd = 0 }) {
  const cpa = conversions > 0 ? Math.round((spendUsd / conversions) * 100) / 100 : null;
  const roas = spendUsd > 0 ? Math.round((conversionValueUsd / spendUsd) * 100) / 100 : null;
  const out = { cpa, roas, cpaTargetUsd, roasTarget, status: 'no_target' };
  if (cpaTargetUsd != null) {
    if (cpa == null) out.status = 'missing';
    else out.status = cpa <= cpaTargetUsd * 1.10 ? 'hitting' : 'missing';
  } else if (roasTarget != null) {
    if (roas == null) out.status = 'missing';
    else out.status = roas >= roasTarget * 0.90 ? 'hitting' : 'missing';
  }
  return out;
}

module.exports = { pace, sortPacing, targetStatus, daysInMonth };
