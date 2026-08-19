// Rules engine core — build-doc §2–3.
// Deterministic: every number engine-computed; Sonnet later writes title and
// explanation ONLY (narration stage receives findings minus payload).
// Severity and thresholds come from rule_config rows, never from code paths,
// so tuning needs no deploy. Dedupe and suspect handling per §2.2.

const { sortWeight } = require('./sort-weight');

const DEFAULT_MONEY = { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' };

/**
 * @param {object} p
 *   p.rules         [{ rule_id, layer, run(ctx) -> partialFinding[] }]
 *   p.ruleConfig    { [rule_id]: { default_severity, thresholds, fix_tool_id, enabled } }
 *   p.ctx           rule input: snapshots + tenant context (shape per layer module)
 *   p.priorFindings [{ rule_id, entity_key, first_seen_run_id, status }] from earlier runs
 *   p.runId, p.tenantId
 * Partial finding contract (what a rule returns):
 *   { category, entity_key, evidence, payload, fix?, money?, severity_override? }
 * @returns {{ findings: [], errors: [], counts: {} }}
 */
function runRules({ rules, ruleConfig, ctx, priorFindings = [], runId, tenantId }) {
  const prior = new Map(priorFindings.map((f) => [`${f.rule_id}::${f.entity_key}`, f]));
  const findings = [];
  const errors = [];

  for (const rule of rules) {
    const config = ruleConfig[rule.rule_id];
    if (!config || config.enabled === false) continue;
    let hits;
    try {
      hits = rule.run({ ...ctx, thresholds: config.thresholds || {} }) || [];
    } catch (err) {
      // A broken rule degrades the run honestly; it never sinks it (§2.3).
      errors.push({ rule_id: rule.rule_id, message: String(err.message || err) });
      continue;
    }
    for (const hit of hits) {
      const severity = hit.severity_override || config.default_severity;
      const money = { ...DEFAULT_MONEY, ...(hit.money || {}) };
      const seen = prior.get(`${rule.rule_id}::${hit.entity_key}`);
      const suspect = seen && seen.status === 'suspect';
      const fix = hit.fix
        ? { available: !suspect, tool_id: config.fix_tool_id || hit.fix.tool_id, ...hit.fix, ...(suspect ? { available: false } : {}) }
        : { available: false, tool_id: null, params_ref: null, risk: 'low', reversible: true, approval_scope: 'change' };
      findings.push({
        schema_version: 1,
        run_id: runId,
        tenant_id: tenantId,
        rule_id: rule.rule_id,
        layer: rule.layer,
        severity,
        // §2.2 suspect: a reverted finding returns marked suspect and its
        // identical fix is never re-proposed while suspect.
        status: suspect ? 'suspect' : 'open',
        category: hit.category,
        entity_key: hit.entity_key,
        first_seen_run_id: seen ? seen.first_seen_run_id : runId,
        title: null, // narration stage
        explanation: null, // narration stage
        money,
        evidence: hit.evidence || { metrics: {}, window_days: 0, queries: [] },
        payload: { locked: true, entities: [], fix_detail: '', ...(hit.payload || {}) },
        fix,
        display: {
          icon: hit.icon || 'alert-triangle',
          badge_color: severity,
          sort_weight: sortWeight(severity, money.impact_monthly_usd),
        },
      });
    }
  }

  findings.sort((a, b) => b.display.sort_weight - a.display.sort_weight);
  const counts = { critical: 0, warning: 0, opportunity: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { findings, errors, counts };
}

/**
 * Health score — build-doc §13. 0–100, deterministic, same formula everywhere.
 * 100 − Σ severity penalties (critical 15, warning 5, penalties capped at 85)
 * + data-quality modifier, clamped to [0, 100]. Stored on the run.
 */
function healthScore(findings, dataQualityModifier = 0) {
  let penalties = 0;
  for (const f of findings) {
    if (f.status === 'resolved' || f.status === 'dismissed') continue;
    if (f.severity === 'critical') penalties += 15;
    else if (f.severity === 'warning') penalties += 5;
  }
  penalties = Math.min(85, penalties);
  return Math.max(0, Math.min(100, 100 - penalties + dataQualityModifier));
}

module.exports = { runRules, healthScore };
