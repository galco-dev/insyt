// The monthly learning job — engine-spec §10.6 / §11.9. Fetches the
// telemetry (pooled only from consenting tenants, min-N enforced in the
// loops), runs the five loops, applies governance, records proposals in
// tuning_log (status 'proposed' — nothing is ever applied here), writes the
// review artefact, and reports instrumentation incidents.
//
//   runLearningJob({ db, month, now }) -> { month, proposals, carried, rejected, incidents, review_md }
// The review is the monthly ritual: read diffs with receipts (§11.9).

const loops = require('./loops');
const gov = require('./governance');
const { renderReview } = require('./review');

const q = (s) => encodeURIComponent(s);

async function fetchAll({ db, since }) {
  const s = q(since);
  const [tenants, watches, dismissals, changes, exceptions, snapshots, edits, unanswered, events, journeys, anomalies, heartbeat] = await Promise.all([
    db.select('tenants', 'select=id,benchmark_consent,vertical,size_band').catch(() => []),
    db.select('watches', `kind=eq.change_verify&status=eq.resolved&closed_at=gte.${s}&select=tenant_id,outcome,effect,schedule,baseline,closed_at`).catch(() => []),
    db.select('dismissals', `created_at=gte.${s}&select=tenant_id,rule_id,reason_tap,expanded_first`).catch(() => []),
    db.select('changes', `created_at=gte.${s}&select=tenant_id,status,finding:findings(rule_id)`).catch(() => []),
    db.select('standing_exceptions', 'cleared_at=is.null&select=tenant_id,change_key').catch(() => []),
    db.select('asset_perf_snapshots', `created_at=gte.${s}&select=tenant_id,text,performance_label`).catch(() => []),
    db.select('draft_edits', `created_at=gte.${s}&select=tenant_id,artifact_id,artifact_kind`).catch(() => []),
    db.select('unanswered_log', `created_at=gte.${s}&select=tenant_id,source,text`).catch(() => []),
    db.select('events', `created_at=gte.${s}&select=tenant_id,name,props&limit=20000`).catch(() => []),
    db.select('journey_state', 'select=tenant_id,gates,tag_install').catch(() => []),
    db.select('anomaly_calendar', 'select=tenant_id,starts_on,ends_on,label').catch(() => []),
    db.select('telemetry_heartbeat', 'select=stream,last_write_at,writes_today').catch(() => []),
  ]);
  return { tenants, watches, dismissals, changes, exceptions, snapshots, edits, unanswered, events, journeys, anomalies, heartbeat };
}

async function runLearningJob({ db, month = null, now = Date.now(), lookbackDays = 90 }) {
  const monthKey = month || `${new Date(now).toISOString().slice(0, 7)}-01`;
  const since = new Date(now - lookbackDays * 86_400_000).toISOString();
  const d = await fetchAll({ db, since });

  // Pooled learning consent (§11.6): only consenting tenants feed cross-account loops.
  const pooled = new Set((d.tenants || []).filter((t) => t.benchmark_consent === true).map((t) => t.id));
  const only = (rows) => (rows || []).filter((r) => !r.tenant_id || pooled.has(r.tenant_id));

  const l1 = loops.interventionOutcomes({ watches: only(d.watches), anomalies: d.anomalies || [] });
  const l2 = loops.humanJudgment({ dismissals: only(d.dismissals), changes: only(d.changes).map((c) => ({ status: c.status, rule_id: c.finding && c.finding.rule_id })), exceptions: only(d.exceptions) });
  const l3 = loops.creative({ snapshots: only(d.snapshots), edits: only(d.edits) });
  const l4 = loops.assistantSelfReport({ unanswered: d.unanswered || [] }); // product backlog, not tenant-shaping: all sources
  const l5 = loops.funnel({ events: d.events || [], journeys: d.journeys || [] });

  const all = [...l1.proposals, ...l2.proposals, ...l3.proposals, ...l4.proposals, ...l5.proposals];
  const rejected = []; const tunable = [];
  for (const p of all) { const t = gov.assertTunable(p); if (t.ok) tunable.push(p); else rejected.push({ ...p, why: t.why }); }
  // Backlog items are not config tunings; they do not consume the ≤5 budget.
  const config = tunable.filter((p) => p.target !== 'backlog');
  const backlog = tunable.filter((p) => p.target === 'backlog');
  const { chosen, carried } = gov.capPerCycle(config);
  const hb = gov.heartbeatCheck(d.heartbeat || [], { now });

  // Record proposals (status proposed). Applying is a human act via PR (§11.9).
  const rows = [...chosen, ...backlog].map((p) => ({ proposal: { target: p.target, key: p.key, from: p.from, to: p.to, loop: p.loop, rationale: p.rationale }, evidence: p.evidence || {}, status: 'proposed' }));
  if (rows.length) await db.insert('tuning_log', rows, { returning: false }).catch(() => {});

  const review_md = renderReview({ month: monthKey, pooledTenants: pooled.size, totalTenants: (d.tenants || []).length, loops: { l1, l2, l3, l4, l5 }, chosen, carried, backlog, rejected, heartbeat: hb });
  await db.upsert('learning_reviews', [{ month: monthKey, body_md: review_md, proposals: { chosen, carried, backlog, rejected }, incidents: hb.incidents, created_at: new Date(now).toISOString() }], 'month').catch(() => {});
  return { month: monthKey, proposals: chosen, backlog, carried, rejected, incidents: hb.incidents, review_md };
}

module.exports = { runLearningJob, fetchAll };
