// sort_weight — build-doc §2.2. Severity base + money factor, computed by
// code so report, email and dashboard order identically. Never model-decided.

const SEVERITY_BASE = { critical: 80, warning: 60, opportunity: 40, info: 10 };

function sortWeight(severity, moneyMonthlyUsd = 0) {
  const base = SEVERITY_BASE[severity] ?? 0;
  const moneyFactor = Math.min(19, Math.round((moneyMonthlyUsd || 0) / 25));
  return base + moneyFactor;
}

module.exports = { sortWeight, SEVERITY_BASE };
