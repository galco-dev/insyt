// Governance — engine-spec §11.7–11.9. The learning layer proposes; it never
// applies. This module is the constitution in code:
//   - the never-tune list (safety floors, consent lanes, paywall, tracking
//     severity, pricing) rejects proposals before they are even recorded
//   - the tuning-rate budget (≤5 config changes per cycle) keeps outcomes attributable
//   - shadow mode evaluates a threshold proposal against what recent runs
//     actually saw before anyone reads it
//   - every applied tuning opens its own watch
//   - instrumentation heartbeat: a silent stream is an incident

const NEVER_TUNE = [
  { re: /^bounds\./, why: 'safety-bound floors are constitutional (§4.2)' },
  { re: /^consent\./, why: 'consent lanes are constitutional (§7.2)' },
  { re: /^paywall/, why: 'the paywall line is constitutional' },
  { re: /^pricing/, why: 'pricing: the data advises, a human decides' },
  { re: /tracking.*severity|severity.*tracking|^(live|fire|gtm)\..*critical/, why: 'tracking-breakage severity never softens' },
  { re: /^(autopilot|autopilot_categories)/, why: 'the autopilot ceiling is fixed (§4.3)' },
];
const MAX_TUNINGS_PER_CYCLE = 5;

function assertTunable(proposal) {
  const key = `${proposal.target}.${proposal.key || ''}`;
  for (const n of NEVER_TUNE) if (n.re.test(key) || n.re.test(String(proposal.key || ''))) return { ok: false, why: n.why };
  return { ok: true };
}

/** Keep at most N proposals per cycle, best evidence first; the rest are carried, never dropped silently. */
function capPerCycle(proposals, max = MAX_TUNINGS_PER_CYCLE) {
  const score = (p) => (p.evidence && (p.evidence.n || p.evidence.proposed || p.evidence.issued || p.evidence.exceptions)) || 0;
  const sorted = [...proposals].sort((a, b) => score(b) - score(a));
  return { chosen: sorted.slice(0, max), carried: sorted.slice(max) };
}

/**
 * Shadow mode for a numeric threshold proposal: replay stored findings'
 * evidence metrics against the candidate threshold and report what would
 * have fired vs did fire. findings: rows with rule_id + evidence.metrics.
 * candidate: { rule_id, metric, op ('gte'|'lte'), current, proposed }.
 */
function shadowThreshold({ findings = [], candidate }) {
  const rows = findings.filter((f) => f.rule_id === candidate.rule_id && f.evidence && f.evidence.metrics && candidate.metric in f.evidence.metrics);
  const passes = (v, t) => (candidate.op === 'lte' ? v <= t : v >= t);
  const fired = rows.length;
  const wouldFire = rows.filter((f) => passes(Number(f.evidence.metrics[candidate.metric]), candidate.proposed)).length;
  const approvedNow = rows.filter((f) => ['approved', 'applied'].includes(f.status)).length;
  const approvedWould = rows.filter((f) => ['approved', 'applied'].includes(f.status) && passes(Number(f.evidence.metrics[candidate.metric]), candidate.proposed)).length;
  return {
    n: fired, would_fire: wouldFire, suppressed: fired - wouldFire,
    approved_rate_now: fired ? Math.round((approvedNow / fired) * 100) : null,
    approved_rate_would: wouldFire ? Math.round((approvedWould / wouldFire) * 100) : null,
    verdict: fired < 20 ? 'insufficient' : (wouldFire ? (approvedWould / wouldFire) : 0) >= (fired ? approvedNow / fired : 0) ? 'candidate_wins' : 'incumbent_wins',
  };
}

/** Instrumentation health: streams that should write daily but have gone quiet. */
function heartbeatCheck(rows = [], { now = Date.now(), maxSilenceHours = { events: 24, spend_daily: 48, model_usage: 24 * 7, dismissals: 24 * 14, draft_edits: 24 * 30, asset_perf: 24 * 8, unanswered: 24 * 30 } } = {}) {
  const incidents = [];
  for (const [stream, hours] of Object.entries(maxSilenceHours)) {
    const row = rows.find((r) => r.stream === stream);
    const last = row ? Date.parse(row.last_write_at) : null;
    if (!last) { incidents.push({ stream, why: 'never written' }); continue; }
    const silent = (now - last) / 3_600_000;
    if (silent > hours) incidents.push({ stream, why: `silent for ${Math.round(silent)}h (limit ${hours}h)` });
  }
  return { ok: incidents.length === 0, incidents };
}

/** Every applied tuning opens its own watch (§11.8): did precision improve, did dismissals fall, did effect sizes hold. */
function tuningWatch(tuning, appliedAt, days = 30) {
  return {
    kind: 'tag_alive', // reuse the generic active-watch pump; judged by the next learning cycle, not the poller
    status: 'active', target_id: tuning.id || null,
    schedule: { until: new Date(Date.parse(appliedAt) + days * 86_400_000).toISOString(), days, kind: 'tuning' },
    baseline: { proposal: tuning.proposal, evidence: tuning.evidence, applied_at: appliedAt },
  };
}

module.exports = { NEVER_TUNE, MAX_TUNINGS_PER_CYCLE, assertTunable, capPerCycle, shadowThreshold, heartbeatCheck, tuningWatch };
