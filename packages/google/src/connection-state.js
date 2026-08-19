// google_connections status state machine — build-doc §6.
//   valid --(refresh fail: invalid_grant)--> expired --(reconnect)--> valid
//   valid --(scope missing)--> partial --(re-consent)--> valid
//   any --(user revoked at Google, seen on validation)--> revoked --(reconnect)--> valid
// Every transition is ledgered (connection_changed) by the caller via the
// returned event; this module is pure state logic.

const STATUSES = ['valid', 'expired', 'partial', 'revoked'];

const TRANSITIONS = {
  valid: { refresh_failed: 'expired', scope_missing: 'partial', revoked_at_google: 'revoked' },
  expired: { reconnected: 'valid', revoked_at_google: 'revoked' },
  partial: { reconsented: 'valid', refresh_failed: 'expired', revoked_at_google: 'revoked' },
  revoked: { reconnected: 'valid' },
};

// Customer-facing summary line per §4 register — no jargon, one action.
const CUSTOMER_COPY = {
  expired: 'Your Google connection needs a quick refresh — one tap to reconnect.',
  partial: "We can see some of your Google setup but not all of it — reconnect to let us check everything.",
  revoked: 'Your Google connection was switched off — one tap to reconnect.',
  valid: 'Google connection healthy.',
};

/**
 * Apply an event to a connection status.
 * @returns {{ status: string, changed: boolean, ledger?: object }}
 * Unknown events for a status are no-ops (poller may double-report).
 */
function transition(current, event, detail = {}) {
  if (!STATUSES.includes(current)) throw new Error(`unknown status: ${current}`);
  const next = (TRANSITIONS[current] || {})[event];
  if (!next || next === current) return { status: current, changed: false };
  return {
    status: next,
    changed: true,
    ledger: {
      event: 'connection_changed',
      summary_text: CUSTOMER_COPY[next],
      detail: { from: current, to: next, cause: event, ...detail },
    },
  };
}

/**
 * Classify a Google token-endpoint error into a state-machine event.
 * invalid_grant covers both expiry and user revocation; revocation is only
 * distinguishable via the validation sweep (revoked_at_google there).
 */
function classifyTokenError(errBody) {
  const code = (errBody && (errBody.error || errBody.code)) || '';
  if (code === 'invalid_grant') return 'refresh_failed';
  if (code === 'invalid_scope' || code === 'insufficient_scope') return 'scope_missing';
  return null; // transient — retry, do not transition
}

/** Connections due for the weekly proactive validation sweep (§6, master §11). */
function dueForValidation(connections, now, intervalDays = 7) {
  const cutoff = now - intervalDays * 24 * 3600 * 1000;
  return connections.filter((c) => {
    if (c.status === 'revoked') return false; // needs user action, not polling
    const last = c.last_validated_at ? Date.parse(c.last_validated_at) : 0;
    return last < cutoff;
  });
}

module.exports = { STATUSES, TRANSITIONS, transition, classifyTokenError, dueForValidation, CUSTOMER_COPY };
