// The gate (gated-platform spec §1). Pure: rows in, access out. Three levels:
//   locked    signed in, no audit fee paid          reads free, fixes blurred
//   unlocked  audit fee paid, no plan               reads free, every write opens the Plan sheet
//   active    plan active / trialing / past_due     the product
// past_due counts as active on purpose: the grace ladder degrades, it never
// cuts (master §11). The numbers ride along so every gated state can speak in
// the customer's own figures.

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
const PAID_KINDS = new Set(['audit_unlock', 'large_audit', 'setup_bundle']);
const TIER_LABEL = { core: 'Core', autopilot: 'Autopilot', scale: 'Scale' };
const AUTOPILOT_TIERS = new Set(['autopilot', 'scale']);
const DEFAULT_MATRIX = { core: { '4k': 129, '10k': 179, '25k': 249 }, autopilot: { '4k': 199, '10k': 279, '25k': 379 }, scale: { '4k': 399, '10k': 499, '25k': 699 } };

const planIsActive = (sub) => !!(sub && ACTIVE_STATUSES.has(String(sub.status || '').toLowerCase()));

/**
 * @param {object} rows
 *   paid     payments row (kind) or null
 *   sub      latest subscriptions row (tier, status, price_usd, stripe_customer_id) or null
 *   tenant   tenants row (size_band) or null
 *   pricing  pricing_config row (matrix) or null
 *   report   latest reports row (summary, findings_snapshot) or null
 *   pending  proposed changes (money_impact_usd, finding.money_impact_monthly_usd)
 *   ads      ads_account asset (currency) or null
 */
function accessFrom({ paid, sub, tenant, pricing, report, pending, ads, now = Date.now() }) {
  const isPaid = !!(paid && PAID_KINDS.has(paid.kind || 'audit_unlock') && !paid.refunded_at);
  const active = planIsActive(sub);
  const level = active ? 'active' : isPaid ? 'unlocked' : 'locked';
  const band = (tenant && tenant.size_band) || '4k';
  const matrix = (pricing && pricing.matrix) || DEFAULT_MATRIX;
  const price = (tier) => Number((matrix[tier] && matrix[tier][band]) || DEFAULT_MATRIX[tier][band]);
  const summary = (report && report.summary) || null;
  let waste = summary && summary.waste_monthly_usd != null ? Math.round(Number(summary.waste_monthly_usd)) : null;
  if (waste == null && report && Array.isArray(report.findings_snapshot)) {
    waste = Math.round(report.findings_snapshot
      .filter((f) => f.severity === 'warning' || f.severity === 'critical')
      .reduce((s, f) => s + Number((f.money && f.money.impact_monthly_usd) || f.money_impact_monthly_usd || 0), 0));
  }
  const rows = pending || [];
  const pendingValue = Math.round(rows.reduce((s, r) => s + Number(r.money_impact_usd || (r.finding && r.finding.money_impact_monthly_usd) || 0), 0));
  return {
    level,
    paid: isPaid,
    plan: sub ? { tier: sub.tier, status: sub.status, label: TIER_LABEL[sub.tier] || sub.tier, price_usd: sub.price_usd != null ? Number(sub.price_usd) : price(sub.tier) } : null,
    has_customer: !!(sub && sub.stripe_customer_id) || isPaid,
    // The $20 comes off the first month once, for tenants who paid the fee and
    // never held a plan. A canceled plan does not earn a second credit.
    // What they paid, capped at $20; a 100% code paid nothing, so nothing comes off.
    credit_usd: isPaid && !sub ? Math.min(paid.amount_usd != null ? Number(paid.amount_usd) : 20, 20) : 0,
    credit_applies: isPaid && !sub && Math.min(paid.amount_usd != null ? Number(paid.amount_usd) : 20, 20) > 0,
    band,
    price_usd: price('core'),
    prices: { core: price('core'), autopilot: price('autopilot'), scale: price('scale') },
    waste_monthly_usd: waste,
    currency: (ads && ads.currency) || (summary && summary.currency) || 'USD',
    pending_count: rows.length,
    pending_value_usd: pendingValue,
    has_report: !!report,
    // Undo stays free for 30 days after cancelling (fix plan move 13).
    undo_until: sub && String(sub.status || '').toLowerCase() === 'canceled' && sub.canceled_at && Date.parse(sub.canceled_at) + 30 * 86_400_000 > now
      ? new Date(Date.parse(sub.canceled_at) + 30 * 86_400_000).toISOString() : null,
    paused_until: tenant && tenant.paused_until && Date.parse(tenant.paused_until) > now ? tenant.paused_until : null,
    findings_count: report ? (summary && summary.counts ? Object.values(summary.counts).reduce((s, n) => s + Number(n || 0), 0) : (Array.isArray(report.findings_snapshot) ? report.findings_snapshot.length : 0)) : null,
  };
}

/** Worker-side: autopilot only counts on an Autopilot or Scale plan that is active. */
const autopilotAllowed = (sub) => planIsActive(sub) && AUTOPILOT_TIERS.has(String(sub.tier || '').toLowerCase());

/** `next` for Checkout return URLs: an /app path on our own origin, nothing else. */
function safeNext(next, fallback = '/app/approvals') {
  const s = String(next || '');
  if (!/^\/app(\/[A-Za-z0-9._~\-/]*)?(\?[A-Za-z0-9._~\-=&%]*)?$/.test(s) || s.includes('//')) return fallback;
  return s;
}

module.exports = { accessFrom, planIsActive, autopilotAllowed, safeNext, ACTIVE_STATUSES, PAID_KINDS };
