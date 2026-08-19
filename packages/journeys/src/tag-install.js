// Tag-installation state machine — build-doc §9, master §9.
// Ambient verification: polling starts when the guide is issued and NEVER
// requires user confirmation. "I've done it" merely accelerates the next poll.
// State persists indefinitely; detection at any point resumes the cascade.
//
// journey_state.tag_install shape:
//   { platform, guide_issued_at, poll_count, next_poll_at, stage,
//     nudges_sent: [], verified_at }
// stage: awaiting_install → detected → cascading → verified | corrective

const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;

// §9 polling schedule: 2min ×15 → 10min ×12 → 1h ×24 → 6h ×28 → daily forever.
const SCHEDULE = [
  { every: 2 * MIN, times: 15 },
  { every: 10 * MIN, times: 12 },
  { every: 1 * HOUR, times: 24 },
  { every: 6 * HOUR, times: 28 },
];

function pollDelay(pollCount) {
  let n = pollCount;
  for (const band of SCHEDULE) {
    if (n < band.times) return band.every;
    n -= band.times;
  }
  return DAY; // daily forever
}

/** Nudge ladder: +4h gentle, day 2 video, day 4 web-person fallback. */
const NUDGES = [
  { id: 'tag_nudge_1', after_ms: 4 * HOUR },
  { id: 'tag_nudge_2', after_ms: 2 * DAY },
  { id: 'tag_nudge_3', after_ms: 4 * DAY },
];

function dueNudge(state, now) {
  const issued = Date.parse(state.guide_issued_at);
  const sent = new Set(state.nudges_sent || []);
  if (state.stage !== 'awaiting_install') return null;
  for (const n of NUDGES) {
    if (!sent.has(n.id) && now - issued >= n.after_ms) return n.id;
  }
  return null;
}

/**
 * Advance the machine on a poll result.
 * pollResult: { container_seen, collect_fired_correct_id, coverage_ok, ga4_data_arrived }
 * Cascade (§9): source check → live render → coverage crawl → data arrival.
 * Returns { state, effects: [{type, ...}] } — effects are emails/gates for the caller.
 */
function advance(state, pollResult, now) {
  const s = { ...state, poll_count: (state.poll_count || 0) + 1 };
  const effects = [];

  if (!pollResult || !pollResult.container_seen) {
    // Still nothing (or vanished mid-cascade) — keep polling on the schedule.
    if (s.stage !== 'awaiting_install' && !s.verified_at) s.stage = 'awaiting_install';
    s.next_poll_at = new Date(now + pollDelay(s.poll_count)).toISOString();
    const nudge = dueNudge(s, now);
    if (nudge) {
      s.nudges_sent = [...(s.nudges_sent || []), nudge];
      effects.push({ type: 'email', template_id: nudge });
    }
    return { state: s, effects };
  }

  // Detection resumes the cascade wherever polling had got to.
  if (!pollResult.collect_fired_correct_id) {
    s.stage = 'corrective';
    effects.push({ type: 'email', template_id: 'tag_corrective', reason: 'installed_not_firing' });
  } else if (!pollResult.coverage_ok) {
    s.stage = 'corrective';
    effects.push({ type: 'email', template_id: 'tag_corrective', reason: 'coverage_gap' });
  } else if (!pollResult.ga4_data_arrived) {
    s.stage = 'cascading'; // green so far; data arrival usually minutes behind
  } else {
    s.stage = 'verified';
    s.verified_at = new Date(now).toISOString();
    effects.push({ type: 'gate', gate: 'tag', value: true });
    effects.push({ type: 'email', template_id: 'tag_verified' });
    effects.push({ type: 'watch', kind: 'tag_alive' }); // lifetime heartbeat takes over
  }
  // Cascade states re-poll quickly regardless of the backoff band.
  s.next_poll_at = new Date(now + (s.stage === 'verified' ? 7 * DAY : 2 * MIN)).toISOString();
  return { state: s, effects };
}

/** "I've done it" button: accelerate the next check, nothing else. */
function acceleratePoll(state, now) {
  return { ...state, next_poll_at: new Date(now).toISOString() };
}

module.exports = { advance, acceleratePoll, pollDelay, dueNudge, SCHEDULE, NUDGES };
