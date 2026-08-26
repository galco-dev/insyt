// Verification watches with outcomes AND effect sizes — engine-spec §4.4.
// Pure judgement over measured windows; the worker supplies the numbers
// (fetchWindow) and persists the verdict. The learning layer (§11.1) reads
// `effect` — so every close records the deltas, not just the label.
//
//   planWatch(draft, appliedAt, now)      -> watches row (kind 'change_verify')
//   judgeWatch({ kind, baseline, window }) -> { outcome, effect, line, tracking_breakage }
//
// window (from apps/worker watch_close, all for the days since apply):
//   { days, spend_usd, conversions, campaign: { spend_usd, conversions } | null,
//     blocked_terms_spend_usd | null, prior: { spend_usd, conversions } }   prior = same-length window before apply
//
// Outcomes: verified (it worked, here's the number) · inconclusive (stated
// plainly) · regressed (fires watch.change_regressed → rollback card, §4.4).
// tracking_breakage marks the one auto-revert exception (§9.3).

const DAYS = { negatives: 7, budgets: 14, counting: 2 };
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

function planWatch(draft, appliedAt, now = Date.now()) {
  const days = (draft.watch && draft.watch.days) || DAYS[draft.category] || 7;
  return {
    kind: 'change_verify',
    target_id: draft.id || null,
    status: 'active',
    schedule: { until: new Date(Date.parse(appliedAt || new Date(now).toISOString()) + days * 86_400_000).toISOString(), days, kind: (draft.watch && draft.watch.kind) || draft.category || 'generic' },
    baseline: { ...(draft.baseline || {}), applied_at: appliedAt, tool_id: draft.tool_id, target: draft.target, change_key: draft.change_key },
  };
}

function judgeWatch({ kind, baseline = {}, window }) {
  if (!window || !(window.days > 0)) return { outcome: 'inconclusive', effect: {}, line: 'Not enough data arrived to judge this change yet.', tracking_breakage: false };
  const prior = window.prior || { spend_usd: 0, conversions: 0 };
  const effect = {
    days: window.days,
    conversions: r2(window.conversions || 0), prior_conversions: r2(prior.conversions || 0),
    conversions_delta_pct: pct(window.conversions || 0, prior.conversions || 0),
    spend_usd: r2(window.spend_usd || 0), prior_spend_usd: r2(prior.spend_usd || 0),
    spend_delta_pct: pct(window.spend_usd || 0, prior.spend_usd || 0),
  };
  const expected = prior.conversions || 0;
  const tooThin = expected < 3 && (window.conversions || 0) < 3;

  // Tracking-breakage signature: conversions collapse after a counting change.
  if (kind === 'counting') {
    if (expected >= 3 && (window.conversions || 0) <= expected * 0.2) {
      return { outcome: 'regressed', effect, line: `Conversions fell from ${effect.prior_conversions} to ${effect.conversions} after the counting change — reverting to protect your numbers.`, tracking_breakage: true };
    }
    if (tooThin) return { outcome: 'inconclusive', effect, line: 'Too few conversions in the window to judge the counting change either way.', tracking_breakage: false };
    if ((window.conversions || 0) >= expected * 0.6 && (window.conversions || 0) <= expected * 1.6) {
      return { outcome: 'verified', effect, line: `Counting looks sane: ${effect.conversions} conversions over ${window.days} days against ${effect.prior_conversions} before.`, tracking_breakage: false };
    }
    return { outcome: 'inconclusive', effect, line: `Conversion volume moved (${effect.conversions} vs ${effect.prior_conversions}) — worth a look, not a verdict.`, tracking_breakage: false };
  }

  if (kind === 'negatives') {
    effect.blocked_terms_spend_usd = window.blocked_terms_spend_usd == null ? null : r2(window.blocked_terms_spend_usd);
    const stopped = window.blocked_terms_spend_usd != null ? window.blocked_terms_spend_usd <= 1 : null;
    if (expected >= 5 && (window.conversions || 0) < expected * 0.6) {
      return { outcome: 'regressed', effect, line: `Conversions dropped ${Math.abs(effect.conversions_delta_pct)}% in the week after the exclusions — proposing to undo them.`, tracking_breakage: false };
    }
    if (stopped === false) return { outcome: 'inconclusive', effect, line: `The excluded searches still spent $${effect.blocked_terms_spend_usd} — checking whether the exclusion took.`, tracking_breakage: false };
    if (stopped === null && tooThin) return { outcome: 'inconclusive', effect, line: 'Not enough traffic in the window to judge.', tracking_breakage: false };
    return { outcome: 'verified', effect, line: `Spend on the excluded searches stopped; conversions held (${effect.conversions} vs ${effect.prior_conversions} the week before).`, tracking_breakage: false };
  }

  if (kind === 'budgets') {
    const c = window.campaign || null;
    const cpa = c && c.conversions > 0 ? r2(c.spend_usd / c.conversions) : null;
    effect.campaign = c ? { spend_usd: r2(c.spend_usd), conversions: r2(c.conversions), cpa_usd: cpa } : null;
    effect.baseline_cpa_usd = baseline.cpa_30d_usd ?? null;
    effect.cpa_delta_pct = cpa != null && baseline.cpa_30d_usd ? pct(cpa, baseline.cpa_30d_usd) : null;
    if (!c || (c.conversions < 3 && (baseline.conversions_30d || 0) < 3)) {
      return { outcome: 'inconclusive', effect, line: 'Too few results in the window to judge the budget move.', tracking_breakage: false };
    }
    if (cpa != null && baseline.cpa_30d_usd && cpa > baseline.cpa_30d_usd * 1.5 && c.conversions >= 3) {
      return { outcome: 'regressed', effect, line: `Cost per result rose to $${cpa} (from $${baseline.cpa_30d_usd}) after the budget change — proposing to put it back.`, tracking_breakage: false };
    }
    if (cpa != null && baseline.cpa_30d_usd && cpa <= baseline.cpa_30d_usd * 1.15) {
      return { outcome: 'verified', effect, line: `Cost per result held at $${cpa} (was $${baseline.cpa_30d_usd}) across ${r2(c.conversions)} results.`, tracking_breakage: false };
    }
    return { outcome: 'inconclusive', effect, line: `Cost per result moved to $${cpa} (from $${baseline.cpa_30d_usd}); within noise, watching the next run.`, tracking_breakage: false };
  }

  // generic (ask-first tools without a specific measure): sanity on account conversions
  if (expected >= 5 && (window.conversions || 0) < expected * 0.5) {
    return { outcome: 'regressed', effect, line: `Conversions halved after the change — proposing to undo it.`, tracking_breakage: false };
  }
  if (tooThin) return { outcome: 'inconclusive', effect, line: 'Not enough data to judge yet.', tracking_breakage: false };
  return { outcome: 'verified', effect, line: `Numbers held steady for ${window.days} days after the change.`, tracking_breakage: false };
}

module.exports = { planWatch, judgeWatch, DAYS };
