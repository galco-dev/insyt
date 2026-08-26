// diff_pass — engine-spec §6.1. Compares this run's findings with the
// findings still open from earlier runs, so the report can say what is new,
// what is still open (and since when), and what went away — and so the
// database never carries two open rows for the same thing.
//
// diffFindings({ findings, prior, now }) ->
//   findings   this run's findings annotated with first_seen_at, is_new, still_open_days
//   supersede  prior row ids that recur this run (their new row carries first_seen) → status 'superseded'
//   resolved   prior rows that no longer fire → status 'resolved' + ledger line
//   summary    { new, still_open, resolved, longest_open_days }   (deterministic "since last week")
//
// prior rows: { id, rule_id, entity_key, status, first_seen_run_id, first_seen_at, created_at }
// Only open/approved/suspect rows are "prior"; applied/dismissed ones are history.

const DAY = 86_400_000;

function diffFindings({ findings, prior = [], now = Date.now() }) {
  const key = (f) => `${f.rule_id}::${f.entity_key}`;
  const priorByKey = new Map();
  for (const p of prior) {
    const k = key(p);
    // keep the OLDEST first-seen per key when duplicates exist
    const cur = priorByKey.get(k);
    if (!cur || Date.parse(p.first_seen_at || p.created_at || 0) < Date.parse(cur.first_seen_at || cur.created_at || 0)) priorByKey.set(k, p);
  }
  const seen = new Set();
  const supersede = [];
  const annotated = findings.map((f) => {
    const k = key(f);
    seen.add(k);
    const p = priorByKey.get(k);
    const firstSeenAt = p ? (p.first_seen_at || p.created_at || new Date(now).toISOString()) : new Date(now).toISOString();
    const days = p ? Math.max(0, Math.floor((now - Date.parse(firstSeenAt)) / DAY)) : 0;
    return { ...f, first_seen_at: firstSeenAt, first_seen_run_id: p ? (p.first_seen_run_id || f.first_seen_run_id) : f.first_seen_run_id, is_new: !p, still_open_days: days };
  });
  for (const p of prior) if (seen.has(key(p))) supersede.push(p.id);
  const resolved = [];
  const resolvedKeys = new Set();
  for (const p of prior) {
    const k = key(p);
    if (seen.has(k) || resolvedKeys.has(k)) continue;
    resolvedKeys.add(k);
    resolved.push({ id: p.id, rule_id: p.rule_id, entity_key: p.entity_key, title: p.title || null, was_suspect: p.status === 'suspect' });
  }
  const stillOpen = annotated.filter((f) => !f.is_new);
  return {
    findings: annotated,
    supersede: supersede.filter((id) => id != null),
    resolved,
    summary: {
      new: annotated.length - stillOpen.length,
      still_open: stillOpen.length,
      resolved: resolved.length,
      longest_open_days: stillOpen.reduce((m, f) => Math.max(m, f.still_open_days), 0),
    },
  };
}

/** Plain-words "since last week" line, deterministic (the model may restyle it, never the numbers). */
function sinceLastWeekLine(summary, firstRun) {
  if (firstRun) return 'This is our first look at your account, so everything here is new.';
  const parts = [];
  if (summary.resolved) parts.push(`${summary.resolved} thing${summary.resolved === 1 ? '' : 's'} from last time ${summary.resolved === 1 ? 'is' : 'are'} fixed`);
  if (summary.new) parts.push(`${summary.new} new`);
  if (summary.still_open) parts.push(`${summary.still_open} still open${summary.longest_open_days >= 14 ? ` (the oldest for ${summary.longest_open_days} days)` : ''}`);
  return parts.length ? `Since last week: ${parts.join(', ')}.` : 'Since last week: nothing changed.';
}

module.exports = { diffFindings, sinceLastWeekLine };
