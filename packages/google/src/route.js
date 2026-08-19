// Journey routing — master §6 table + build-doc §7 additions.
//
// | Discovery finds        | Journey                                  | First payment |
// | Ads + GA4 + GTM        | A  — audit                               | $20 unlock    |
// | Ads only (± legacy)    | C  — audit → build inside subscription   | $20 unlock    |
// | Nothing                | B  — builder                             | $199 bundle   |
// | GA4/GTM, no Ads        | B variant (Launch Plan + tracking audit) | bundle        |
// | Unsupported CMS (B/C build cases) → polite close, pre-payment
// Build-doc addition: Ads account with $0 spend in 90d → dormant variant
// (reactivation-framed report).
// Size gate: ≤10k search-term rows AND ≤$8k/30d spend → $20 standard audit;
// above → large-account audit $49/$79 + higher band flag. Fees mirror
// pricing_config.audit_fees — thresholds here are the launch defaults.

const SIZE_GATE = {
  standardMaxTermRows90d: 10_000,
  standardMaxSpend30dUsd: 8_000,
  largeFeeTier2TermRows: 50_000, // above → $79, else $49
};

/** Size band from 30-day spend, per §12 bands. */
function sizeBand(spend30dUsd) {
  if (spend30dUsd == null) return null;
  if (spend30dUsd <= 4_000) return '4k';
  if (spend30dUsd <= 10_000) return '10k';
  return '25k';
}

/** Audit fee from the size gate metadata query (§7). */
function auditFee({ searchTermRows90d = 0, spend30dUsd = 0 }, fees = { standard: 20, large: [49, 79] }) {
  const standard = searchTermRows90d <= SIZE_GATE.standardMaxTermRows90d
    && spend30dUsd <= SIZE_GATE.standardMaxSpend30dUsd;
  if (standard) return { kind: 'audit_unlock', amount_usd: fees.standard };
  const amount = searchTermRows90d > SIZE_GATE.largeFeeTier2TermRows ? fees.large[1] : fees.large[0];
  return { kind: 'large_audit', amount_usd: amount };
}

/**
 * Route confirmed assets to a journey.
 * @param {object} p
 *   p.confirmed      assets the user confirmed (matched cards, pre-ticked)
 *   p.cmsFingerprint crawls.cms_fingerprint
 *   p.adsActivity    { spend90dUsd } for the confirmed ads account (null if none)
 * @returns {{ journey: 'A'|'B'|'C', variant: string|null, close: boolean,
 *             close_reason?: string, first_payment: 'audit_unlock'|'bundle'|null }}
 */
function routeJourney({ confirmed, cmsFingerprint, adsActivity }) {
  const kinds = new Set((confirmed || []).map((a) => a.kind));
  const hasAds = kinds.has('ads_account');
  const hasGa4 = kinds.has('ga4_property') || kinds.has('ga4_stream');
  const hasGtm = kinds.has('gtm_container');

  // Build journeys need us to place a tag — unsupported CMS closes politely
  // BEFORE any payment (master §6/§9).
  const needsBuild = !hasAds || !(hasGa4 && hasGtm);
  if (needsBuild && cmsFingerprint === 'unsupported' && !(hasAds && (hasGa4 || hasGtm))) {
    return { journey: null, variant: null, close: true, close_reason: 'unsupported_cms', first_payment: null };
  }

  if (hasAds && hasGa4 && hasGtm) {
    const dormant = adsActivity && adsActivity.spend90dUsd === 0;
    return { journey: 'A', variant: dormant ? 'dormant' : null, close: false, first_payment: 'audit_unlock' };
  }
  if (hasAds) {
    const dormant = adsActivity && adsActivity.spend90dUsd === 0;
    return { journey: 'C', variant: dormant ? 'dormant' : null, close: false, first_payment: 'audit_unlock' };
  }
  if (hasGa4 || hasGtm) {
    return { journey: 'B', variant: 'launch_plan_plus_tracking_audit', close: false, first_payment: 'bundle' };
  }
  return { journey: 'B', variant: null, close: false, first_payment: 'bundle' };
}

module.exports = { routeJourney, sizeBand, auditFee, SIZE_GATE };
