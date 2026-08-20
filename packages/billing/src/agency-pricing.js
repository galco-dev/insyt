// Agency platform pricing — master §13, config not code.
//
// Model (binding):
// - The agency pays: platform fee (tier) + N × band rate, where N is the
//   count of BILLABLE accounts (status pending or active; paused and removed
//   accounts are never billed).
// - Whole-portfolio banding: one rate applies to every account, chosen by N.
//   Crossing a band boundary re-prices the whole portfolio downward,
//   automatically, from the next invoice.
// - Mid-cycle adds are prorated for the days remaining, at the band rate the
//   portfolio lands on AFTER the add (adds can only make the rate better).
// - Removals/pauses take effect at the next invoice; no partial refunds.
// - The platform NEVER touches what the agency charges its clients. No
//   client-fee field exists anywhere in the schema, and none may be added.

const BANDS = [
  { upTo: 10, rate: 45 },
  { upTo: 30, rate: 39 },
  { upTo: Infinity, rate: 35 },
];

const PLATFORM_FEES = { base: 149, mid: 249, top: 399 };

function bandRate(n) {
  if (n <= 0) return 0;
  for (const b of BANDS) if (n <= b.upTo) return b.rate;
  return BANDS[BANDS.length - 1].rate;
}

function bandLabel(n) {
  if (n <= 0) return '—';
  if (n <= 10) return '1–10';
  if (n <= 30) return '11–30';
  return '31+';
}

// Monthly invoice for a billable-account count and platform tier.
function monthlyCharge(n, tier) {
  const fee = PLATFORM_FEES[tier];
  if (fee === undefined) throw new Error(`unknown platform tier: ${tier}`);
  const rate = bandRate(n);
  const accountsSum = n * rate;
  return { accounts: n, rate, band: bandLabel(n), accountsSum, platformFee: fee, total: accountsSum + fee };
}

// One-off prorated charge for adding an account mid-cycle.
// countAfterAdd includes the new account. Rounded to cents.
function prorateAdd({ countAfterAdd, daysRemaining, daysInPeriod }) {
  if (daysInPeriod <= 0) throw new Error('daysInPeriod must be positive');
  const days = Math.max(0, Math.min(daysRemaining, daysInPeriod));
  const rate = bandRate(countAfterAdd);
  return Math.round((rate * days * 100) / daysInPeriod) / 100;
}

// Cycle maths from a billing anchor date (day-of-month semantics: the cycle
// runs anchor→anchor; months shorter than the anchor day clamp to their end).
function cycleFor(anchorIso, nowIso) {
  const anchor = new Date(anchorIso);
  const now = new Date(nowIso);
  const day = anchor.getUTCDate();
  const clamp = (y, m) => Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), clamp(now.getUTCFullYear(), now.getUTCMonth())));
  if (start > now) start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, clamp(now.getUTCFullYear(), now.getUTCMonth() - 1)));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, clamp(start.getUTCFullYear(), start.getUTCMonth() + 1)));
  const dayMs = 86_400_000;
  const daysInPeriod = Math.round((end - start) / dayMs);
  const daysRemaining = Math.max(0, Math.ceil((end - now) / dayMs));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), daysInPeriod, daysRemaining };
}

module.exports = { BANDS, PLATFORM_FEES, bandRate, bandLabel, monthlyCharge, prorateAdd, cycleFor };
