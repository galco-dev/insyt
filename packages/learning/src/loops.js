// The learning layer's five loops — engine-spec §11.1–11.5. Pure analysis
// over rows the job already fetched: each loop returns { metrics, proposals }.
// Proposals are CONFIG changes (rule thresholds, watch durations, money
// priors, copy/ranking flags, brief guidance, backlog items) — never code,
// never anything on the never-tune list (governance.js rejects those).
//
// Statistical honesty (§11.7) is built in: min-N before any pattern is
// used, anomaly-calendar exclusion, pre-change baselines (watch.effect is
// measured against the prior window), and every proposal carries evidence.

const MIN_N = 20;
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
const r2 = (n) => Math.round(n * 100) / 100;

function inAnomaly(dateIso, tenantId, anomalies = []) {
  const d = String(dateIso || '').slice(0, 10);
  return anomalies.some((a) => (a.tenant_id == null || a.tenant_id === tenantId) && d >= a.starts_on && d <= a.ends_on);
}

/** Loop 1 — intervention outcomes (the moat). watches: closed change_verify rows with baseline.tool_id / change_key / kind, outcome, effect, tenant_id, closed_at. */
function interventionOutcomes({ watches = [], anomalies = [], minN = MIN_N } = {}) {
  const usable = watches.filter((w) => w.outcome && !inAnomaly(w.closed_at, w.tenant_id, anomalies));
  const byKind = new Map();
  for (const w of usable) {
    const kind = (w.schedule && w.schedule.kind) || (w.baseline && w.baseline.tool_id) || 'generic';
    const b = byKind.get(kind) || { kind, n: 0, verified: 0, inconclusive: 0, regressed: 0, conv_deltas: [], spend_deltas: [], tenants: new Set() };
    b.n += 1; b[w.outcome] += 1; b.tenants.add(w.tenant_id);
    if (w.effect) { b.conv_deltas.push(Number(w.effect.conversions_delta_pct)); b.spend_deltas.push(Number(w.effect.spend_delta_pct)); }
    byKind.set(kind, b);
  }
  const metrics = [...byKind.values()].map((b) => ({
    kind: b.kind, n: b.n, tenants: b.tenants.size,
    verified_pct: pct(b.verified, b.n), inconclusive_pct: pct(b.inconclusive, b.n), regressed_pct: pct(b.regressed, b.n),
    median_conversions_delta_pct: median(b.conv_deltas), median_spend_delta_pct: median(b.spend_deltas),
  }));
  const proposals = [];
  for (const m of metrics) {
    if (m.n < minN || m.tenants < minN) continue; // pooled learning needs ≥ minN accounts (§11.6)
    if (m.inconclusive_pct >= 50) {
      proposals.push({ target: 'watch_duration', key: m.kind, from: null, to: '+7 days', rationale: `${m.inconclusive_pct}% of ${m.kind} watches close inconclusive (n=${m.n}) — the window is too short to judge.`, evidence: m, loop: 1 });
    }
    if (m.regressed_pct >= 20) {
      proposals.push({ target: 'rule_threshold', key: m.kind, from: null, to: 'tighten', rationale: `${m.regressed_pct}% of ${m.kind} changes regressed (n=${m.n}) — the rule proposes too eagerly; raise its entry threshold.`, evidence: m, loop: 1 });
    }
    if (m.kind === 'negatives' && m.median_spend_delta_pct != null && m.verified_pct >= 60) {
      proposals.push({ target: 'money_prior', key: 'negatives', from: 'spend_90d/3', to: `measured median spend delta ${m.median_spend_delta_pct}%`, rationale: `Measured effect of exclusions across ${m.n} watches; modelled savings should track the measured median.`, evidence: m, loop: 1 });
    }
  }
  return { metrics, proposals };
}

/** Loop 2 — human judgment. dismissals: { rule_id, reason_tap, expanded_first }; changes: { rule_id?, status } via finding join; exceptions: { change_key }. */
function humanJudgment({ dismissals = [], changes = [], exceptions = [], minN = MIN_N } = {}) {
  const byRule = new Map();
  for (const c of changes) {
    const rid = c.rule_id || 'unknown';
    const b = byRule.get(rid) || { rule_id: rid, proposed: 0, approved: 0, dismissed: 0, reasons: {}, expanded_first: 0, dismissal_rows: 0 };
    b.proposed += 1;
    if (['approved', 'applied'].includes(c.status)) b.approved += 1;
    if (c.status === 'failed' || c.status === 'dismissed') b.dismissed += 1;
    byRule.set(rid, b);
  }
  for (const d of dismissals) {
    const b = byRule.get(d.rule_id || 'unknown') || { rule_id: d.rule_id || 'unknown', proposed: 0, approved: 0, dismissed: 0, reasons: {}, expanded_first: 0, dismissal_rows: 0 };
    b.dismissal_rows += 1;
    if (d.reason_tap) b.reasons[d.reason_tap] = (b.reasons[d.reason_tap] || 0) + 1;
    if (d.expanded_first) b.expanded_first += 1;
    byRule.set(b.rule_id, b);
  }
  const metrics = [...byRule.values()].map((b) => ({
    rule_id: b.rule_id, proposed: b.proposed, approved: b.approved, dismissed: b.dismissed,
    dismissal_pct: pct(b.dismissed, b.proposed), expanded_first_pct: pct(b.expanded_first, b.dismissal_rows), reasons: b.reasons,
  }));
  const proposals = [];
  for (const m of metrics) {
    if (m.proposed < minN) continue;
    if (m.dismissal_pct >= 60) {
      const wrong = (m.reasons.wrong || 0) >= (m.reasons.not_now || 0);
      if (m.expanded_first_pct != null && m.expanded_first_pct >= 60 && wrong) {
        proposals.push({ target: 'rule_threshold', key: m.rule_id, from: null, to: 'raise', rationale: `${m.dismissal_pct}% dismissed after opening the detail, mostly "wrong" — the finding itself misfires; raise the threshold.`, evidence: m, loop: 2 });
      } else {
        proposals.push({ target: 'finding_copy', key: m.rule_id, from: null, to: 'rewrite', rationale: `${m.dismissal_pct}% dismissed without opening the detail — the explanation is failing, not the finding.`, evidence: m, loop: 2 });
      }
      proposals.push({ target: 'surfacing', key: m.rule_id, from: 'always', to: 'suppress until threshold review', rationale: 'A finding that cries wolf trains skimming (§11.2).', evidence: m, loop: 2 });
    }
  }
  // Aggregated standing exceptions indict rules: many accounts overriding the same shape.
  const byShape = new Map();
  for (const e of exceptions) { const shape = String(e.change_key || '').split(':')[0]; byShape.set(shape, (byShape.get(shape) || 0) + 1); }
  for (const [shape, n] of byShape) {
    if (n >= minN) proposals.push({ target: 'rule_review', key: shape, from: null, to: 'review', rationale: `${n} accounts told us never to re-apply ${shape} changes — the rule behind it is miscalibrated.`, evidence: { shape, exceptions: n }, loop: 2 });
  }
  return { metrics, proposals };
}

const PATTERNS = [
  { key: 'price_anchored', re: /(\$|AED|USD|£|€)\s?\d|\bfrom \d|\d+\s?(aed|usd)/i },
  { key: 'urgency', re: /\b(today|now|same[- ]day|this week|limited|hurry)\b/i },
  { key: 'service_named', re: /\b(nails?|clean|repair|plumb|dent|lawyer|clinic|salon|removal|tutor|install|service)\b/i },
  { key: 'trust', re: /\b(rated|reviews?|trusted|licensed|certified|years)\b/i },
  { key: 'booking', re: /\b(book|booking|appointment|quote|call)\b/i },
];

/** Loop 3 — creative. snapshots: asset_perf_snapshots rows; edits: draft_edits rows. */
function creative({ snapshots = [], edits = [], minN = MIN_N } = {}) {
  const byPattern = {};
  for (const s of snapshots) {
    const label = String(s.performance_label || '').toUpperCase();
    if (!['BEST', 'GOOD', 'LOW'].includes(label)) continue;
    for (const p of PATTERNS) {
      if (!p.re.test(s.text || '')) continue;
      const b = byPattern[p.key] = byPattern[p.key] || { pattern: p.key, n: 0, best: 0, good: 0, low: 0, tenants: new Set() };
      b.n += 1; b[label.toLowerCase()] += 1; b.tenants.add(s.tenant_id);
    }
  }
  const metrics = Object.values(byPattern).map((b) => ({ pattern: b.pattern, n: b.n, tenants: b.tenants.size, best_pct: pct(b.best, b.n), low_pct: pct(b.low, b.n) }));
  const editRate = { model_drafts: 0, edited: 0 };
  const seen = new Set();
  for (const e of edits) { const k = String(e.artifact_id || '').split(':').slice(0, 2).join(':'); if (!seen.has(k)) { seen.add(k); editRate.edited += 1; } }
  const proposals = [];
  for (const m of metrics) {
    if (m.n < minN || m.tenants < minN) continue;
    if (m.best_pct >= 40) proposals.push({ target: 'copy_brief', key: m.pattern, from: null, to: 'prefer', rationale: `${m.best_pct}% of ${m.pattern} lines are rated BEST across ${m.tenants} accounts (n=${m.n}); lean the drafting brief toward this hook.`, evidence: m, loop: 3 });
    if (m.low_pct >= 50) proposals.push({ target: 'copy_brief', key: m.pattern, from: null, to: 'avoid', rationale: `${m.low_pct}% of ${m.pattern} lines are rated LOW (n=${m.n}); steer the brief away from it.`, evidence: m, loop: 3 });
  }
  return { metrics: { patterns: metrics, edits: editRate }, proposals };
}

/** Loop 4 — assistant self-reporting. unanswered: unanswered_log rows. */
function assistantSelfReport({ unanswered = [], minCluster = 3 } = {}) {
  const STOP = new Set(['the', 'a', 'an', 'my', 'me', 'i', 'to', 'for', 'of', 'and', 'can', 'you', 'please', 'do', 'it', 'is', 'on', 'in', 'this', 'that', 'we', 'our', 'with', 'be', 'want', 'like']);
  const clusters = new Map();
  for (const u of unanswered) {
    const toks = String(u.text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
    const key = toks.slice(0, 3).sort().join(' ') || 'other';
    const c = clusters.get(key) || { cluster: key, n: 0, sources: {}, examples: [] };
    c.n += 1; c.sources[u.source] = (c.sources[u.source] || 0) + 1; if (c.examples.length < 3) c.examples.push(String(u.text).slice(0, 120));
    clusters.set(key, c);
  }
  const ranked = [...clusters.values()].sort((a, b) => b.n - a.n);
  const proposals = ranked.filter((c) => c.n >= minCluster).map((c) => ({ target: 'backlog', key: c.cluster, from: null, to: 'capability', rationale: `${c.n} requests we could not fulfil: "${c.examples[0]}"`, evidence: c, loop: 4 }));
  return { metrics: { clusters: ranked.slice(0, 20), total: unanswered.length }, proposals };
}

/** Loop 5 — funnel, UX, onboarding. events: events rows; journeys: journey_state rows with tag_install. */
function funnel({ events = [], journeys = [], minN = MIN_N } = {}) {
  const screens = {};
  const counts = {};
  for (const e of events) {
    counts[e.name] = (counts[e.name] || 0) + 1;
    if (e.name === 'screen.view' && e.props && e.props.path) screens[e.props.path] = (screens[e.props.path] || 0) + 1;
  }
  const approvals = { approve: counts['approval.approve'] || 0, request: counts['approval.request_change'] || 0 };
  const stalls = {};
  for (const j of journeys) {
    const g = j.gates || {};
    const stage = g.tag === false ? 'tag' : g.billing === false ? 'billing' : g.approval === false ? 'approval' : null;
    if (stage) stalls[stage] = (stalls[stage] || 0) + 1;
  }
  const byPlatform = {};
  for (const j of journeys) {
    const ti = j.tag_install || {};
    if (!ti.guide_platform) continue;
    const b = byPlatform[ti.guide_platform] = byPlatform[ti.guide_platform] || { platform: ti.guide_platform, issued: 0, verified: 0 };
    b.issued += 1; if (ti.verified_at) b.verified += 1;
  }
  const guides = Object.values(byPlatform).map((b) => ({ ...b, success_pct: pct(b.verified, b.issued) }));
  const proposals = [];
  for (const g of guides) {
    if (g.issued >= minN && g.success_pct != null && g.success_pct < 60) proposals.push({ target: 'guide', key: g.platform, from: `${g.success_pct}% success`, to: 'rewrite', rationale: `A ${g.success_pct}% guide is a broken guide (n=${g.issued}).`, evidence: g, loop: 5 });
  }
  const worst = Object.entries(stalls).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= minN) proposals.push({ target: 'onboarding', key: worst[0], from: null, to: 'investigate', rationale: `${worst[1]} accounts are stalled at the ${worst[0]} gate.`, evidence: { stalls }, loop: 5 });
  return { metrics: { events: counts, screens, approvals, stalls, guides }, proposals };
}

module.exports = { interventionOutcomes, humanJudgment, creative, assistantSelfReport, funnel, inAnomaly, MIN_N, PATTERNS };
