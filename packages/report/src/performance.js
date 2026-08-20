// Performance-led report section (agency-specialist audit P0/P1): the page
// clients actually flip to first — "did we hit what we aimed for?". Renders
// only when the agency has set targets for the account (account_targets) and
// spend snapshots exist. Language stays plain: the numbers carry the
// authority, not the vocabulary. Client fees never appear here — targets are
// the agency's operating targets for the work.
//
// input: {
//   month_label: 'August',                       // display only
//   spend_usd, conversions, conversion_value_usd, // month-to-date actuals
//   targets: { monthly_budget_usd, cpa_target_usd, roas_target },
//   pacing: { projected, deltaPct, status } | null,
// }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Math.round(n || 0).toLocaleString('en-US')}`;

function rowsFor(perf) {
  const t = perf.targets || {};
  const rows = [];
  const cpa = perf.conversions > 0 ? perf.spend_usd / perf.conversions : null;
  const roas = perf.spend_usd > 0 ? perf.conversion_value_usd / perf.spend_usd : null;

  if (t.monthly_budget_usd) {
    const p = perf.pacing || {};
    const ok = p.status === 'on_pace' || p.status === 'under';
    rows.push({
      label: 'Spend vs plan',
      actual: `${money(perf.spend_usd)} so far${p.projected ? ` · heading for ${money(p.projected)}` : ''}`,
      target: `${money(t.monthly_budget_usd)} for the month`,
      ok,
      note: p.status === 'over' ? 'Running hot — we are adjusting before it overshoots.'
        : p.status === 'under' ? 'Room left in the plan — spending less than budgeted.'
          : 'On plan.',
    });
  }
  if (t.cpa_target_usd != null) {
    const ok = cpa != null && cpa <= t.cpa_target_usd * 1.10;
    rows.push({
      label: 'Cost per result',
      actual: cpa != null ? money(cpa) : 'no results yet',
      target: `${money(t.cpa_target_usd)} or better`,
      ok,
      note: ok ? 'Hitting the goal.' : cpa == null ? 'Nothing to measure yet this month.' : 'Above the goal — the fixes below are aimed at exactly this.',
    });
  }
  if (t.roas_target != null) {
    const ok = roas != null && roas >= t.roas_target * 0.90;
    rows.push({
      label: 'Return on spend',
      actual: roas != null ? `${roas.toFixed(1)}× back` : 'no sales recorded yet',
      target: `${Number(t.roas_target).toFixed(1)}× or better`,
      ok,
      note: ok ? 'Hitting the goal.' : 'Below the goal — see the fixes below.',
    });
  }
  return rows;
}

/**
 * renderPerformanceSection(perf, TOKENS) -> html string | '' when no targets.
 * TOKENS injected by the caller (render.js) to avoid a circular require.
 */
function renderPerformanceSection(perf, TOKENS) {
  const rows = rowsFor(perf || {});
  if (!rows.length) return '';
  const cells = rows.map((r) => {
    const color = r.ok ? TOKENS.success : TOKENS.warning;
    const badge = r.ok ? 'on target' : 'needs work';
    return `<tr>
      <td style="font-family:${TOKENS.font};font-size:14px;font-weight:600;color:${TOKENS.accent};padding:10px 8px;border-bottom:1px solid ${TOKENS.neutral400};">${esc(r.label)}</td>
      <td style="font-family:${TOKENS.font};font-size:14px;color:#333;padding:10px 8px;border-bottom:1px solid ${TOKENS.neutral400};">${esc(r.actual)}</td>
      <td style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};padding:10px 8px;border-bottom:1px solid ${TOKENS.neutral400};">${esc(r.target)}</td>
      <td style="font-family:${TOKENS.font};font-size:11px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.04em;padding:10px 8px;border-bottom:1px solid ${TOKENS.neutral400};text-align:right;white-space:nowrap;">${badge}</td>
    </tr>
    <tr><td colspan="4" style="font-family:${TOKENS.font};font-size:12px;color:${TOKENS.neutral900};padding:0 8px 10px 8px;border-bottom:1px solid ${TOKENS.neutral400};">${esc(r.note)}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;border:1px solid ${TOKENS.neutral400};border-radius:${TOKENS.radius};">
    <tr><td style="padding:14px 16px 6px 16px;">
      <div style="font-family:${TOKENS.font};font-size:11px;font-weight:500;color:${TOKENS.neutral900};text-transform:uppercase;letter-spacing:.06em;">Against your goals${perf.month_label ? ` — ${esc(perf.month_label)}` : ''}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${cells}</table>
    </td></tr></table>`;
}

module.exports = { renderPerformanceSection };
