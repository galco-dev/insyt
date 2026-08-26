// Safety bounds — engine-spec §4.2, RULED by Max (§9.1, binding). Pure
// functions over drafted changes + account state; never tuned by the
// learning layer (the never-tune list, §11.9). The tool catalogue's own
// guardrails still run at apply time — these are the ENGINE's tighter
// bounds on what it proposes and what autopilot may apply on its own.
//
//   checkBounds(draft, state) -> null | 'reason'
//   state = {
//     account: { daily_budget_total_usd },
//     campaign(id) -> { budget_daily_usd, conversions_30d },
//     weekly_budget_delta_pct,      net |Δ| applied in the last 7 days as % of account daily total
//     converting_terms: Set,        terms with a conversion in 90d (conflicting-negative guard)
//     reverted_30d,                 count of reverted changes in the last 30 days
//     same_run: { budgets: n, counting: n }   changes already drafted this run
//   }

const BOUNDS = Object.freeze({
  budget_max_pct_per_change: 20,
  budget_max_net_pct_per_week: 30,
  budget_floor_daily_usd: 5,
  negatives_max_per_change: 25,
  coverage_max_reduction_pct: 30,
  suspect_reverts_30d: 2,
});

function checkBounds(draft, state) {
  if (!draft || !draft.tool_id) return 'no tool';
  const p = draft.params || {};

  if ((state.reverted_30d || 0) >= BOUNDS.suspect_reverts_30d) {
    return `account is suspect-heavy (${state.reverted_30d} reverted changes in 30 days) — manual review before any new change`;
  }

  if (draft.tool_id === 'ads.adjust_budget') {
    const c = state.campaign ? state.campaign(p.campaign_id) : null;
    if (!c || !(c.budget_daily_usd > 0)) return 'unknown campaign budget';
    if (!(p.new_daily_usd >= BOUNDS.budget_floor_daily_usd)) return `budget below the $${BOUNDS.budget_floor_daily_usd}/day floor`;
    const pct = Math.abs(p.new_daily_usd - c.budget_daily_usd) / c.budget_daily_usd * 100;
    if (pct > BOUNDS.budget_max_pct_per_change + 1e-9) return `budget move ${Math.round(pct)}% exceeds ${BOUNDS.budget_max_pct_per_change}% per change`;
    const net = (state.weekly_budget_delta_pct || 0) + (Math.abs(p.new_daily_usd - c.budget_daily_usd) / (state.account.daily_budget_total_usd || 1)) * 100;
    if (net > BOUNDS.budget_max_net_pct_per_week + 1e-9) return `net budget movement this week would reach ${Math.round(net)}% (limit ${BOUNDS.budget_max_net_pct_per_week}%)`;
    if ((state.same_run && state.same_run.counting) > 0) return 'budget and counting changes never share a run (attribution clarity)';
  }

  if (draft.tool_id === 'ads.add_negative_keywords') {
    if (!Array.isArray(p.terms) || !p.terms.length) return 'no terms';
    if (p.terms.length > BOUNDS.negatives_max_per_change) return `${p.terms.length} terms exceeds ${BOUNDS.negatives_max_per_change} per change`;
    const hit = p.terms.find((t) => state.converting_terms && state.converting_terms.has(t.text));
    if (hit) return `"${hit.text}" converted in the last 90 days — never excluded`;
  }

  if (draft.category === 'counting') {
    if ((state.same_run && state.same_run.counting) > 0) return 'counting changes go one at a time';
    if ((state.same_run && state.same_run.budgets) > 0) return 'budget and counting changes never share a run (attribution clarity)';
  }

  if (draft.tool_id === 'ads.adjust_schedule' || draft.tool_id === 'ads.adjust_geo') {
    if ((p.coverage_reduction_pct || 0) > BOUNDS.coverage_max_reduction_pct) return `coverage reduction ${p.coverage_reduction_pct}% exceeds ${BOUNDS.coverage_max_reduction_pct}%`;
  }

  return null;
}

/**
 * Reallocate-only (§4.2): the engine never raises the account's total on its
 * own. Given this run's budget drafts, pair each raise with cuts drafted in
 * the same run; a raise that cannot be funded by a cut is downgraded to
 * ask-first (a human approval IS the explicit request).
 * Returns the drafts with `funded: bool` set on raises.
 */
function pairBudgetMoves(drafts) {
  const budget = drafts.filter((d) => d.tool_id === 'ads.adjust_budget' && d.params);
  const cuts = budget.filter((d) => d.params.new_daily_usd < d.params.previous_daily_usd);
  const raises = budget.filter((d) => d.params.new_daily_usd > d.params.previous_daily_usd);
  let pool = cuts.reduce((s, d) => s + (d.params.previous_daily_usd - d.params.new_daily_usd), 0);
  for (const r of raises) {
    const need = r.params.new_daily_usd - r.params.previous_daily_usd;
    if (pool + 1e-9 >= need) { pool -= need; r.funded = true; continue; }
    if (pool > 0.5) {
      // Partial funding: shrink the raise to what the cuts free up, so the
      // account total still never rises on the engine's own initiative.
      const next = Math.round((r.params.previous_daily_usd + pool) * 100) / 100;
      const pctUp = Math.round((pool / r.params.previous_daily_usd) * 100);
      r.params = { ...r.params, new_daily_usd: next };
      if (r.after && r.after.line) r.after = { line: r.after.line.replace(/\$[\d,]+ a day \(up \d+%\)/, `$${Math.round(next)} a day (up ${pctUp}%, funded by the cut)`) };
      if (r.summary) r.summary = r.summary.replace(/→ \$[\d,]+$/, `→ $${Math.round(next)}`);
      pool = 0; r.funded = true;
    } else {
      r.funded = false;
    }
  }
  for (const c of cuts) c.funded = true;
  return drafts;
}

module.exports = { BOUNDS, checkBounds, pairBudgetMoves };
