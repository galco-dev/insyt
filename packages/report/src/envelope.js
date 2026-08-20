// Run envelope assembly — build-doc §2.3.
// The single object every downstream consumer receives: renderer, email,
// dashboard, blur layer. Numbers are summed here, in code — narration slots
// arrive from the narration stage and carry prose only.

function assembleEnvelope({ run, findings, ledgerCumulative, narrativeSlots, performance = null }) {
  const counts = { critical: 0, warning: 0, opportunity: 0, info: 0 };
  let waste = 0;
  let applied = 0;
  for (const f of findings) {
    counts[f.severity] += 1;
    if (f.status === 'applied') applied += 1;
    if ((f.status === 'open' || f.status === 'approved' || f.status === 'suspect')
      && f.money && f.money.direction === 'waste') {
      waste += f.money.impact_monthly_usd || 0;
    }
  }
  return {
    schema_version: 1,
    run_id: run.id,
    type: run.type,
    completed: run.status === 'complete' || run.status === 'degraded',
    degraded: run.status === 'degraded',
    degraded_reasons: run.degraded_reasons || [],
    counts,
    totals: {
      waste_monthly_usd: Math.round(waste),
      applied_this_run: applied,
      ledger_cumulative: {
        fixes: (ledgerCumulative && ledgerCumulative.fixes_applied) || 0,
        waste_removed_usd: Math.round((ledgerCumulative && ledgerCumulative.waste_removed_usd) || 0),
      },
    },
    narrative_slots: {
      exec_summary: (narrativeSlots && narrativeSlots.exec_summary) || '',
      since_last_week: (narrativeSlots && narrativeSlots.since_last_week) || '',
      ...(narrativeSlots && narrativeSlots.deep_synthesis ? { deep_synthesis: narrativeSlots.deep_synthesis } : {}),
    },
    // Performance vs the agency's targets (account_targets + spend_daily) —
    // rendered as the "Against your goals" section when present.
    ...(performance ? { performance } : {}),
    findings: [...findings].sort((a, b) => (b.display?.sort_weight || 0) - (a.display?.sort_weight || 0)),
  };
}

module.exports = { assembleEnvelope };
