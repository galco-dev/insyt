const assert = require('node:assert');
const { test } = require('node:test');
const { transition, classifyTokenError, dueForValidation } = require('../src/connection-state');

test('valid → expired on refresh failure, with ledger event', () => {
  const r = transition('valid', 'refresh_failed');
  assert.strictEqual(r.status, 'expired');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.ledger.event, 'connection_changed');
  assert.match(r.ledger.summary_text, /reconnect/i);
});

test('expired → valid on reconnect; partial → valid on re-consent', () => {
  assert.strictEqual(transition('expired', 'reconnected').status, 'valid');
  assert.strictEqual(transition('partial', 'reconsented').status, 'valid');
});

test('revoked only exits via reconnect; unknown events are no-ops', () => {
  assert.strictEqual(transition('revoked', 'refresh_failed').changed, false);
  assert.strictEqual(transition('revoked', 'reconnected').status, 'valid');
  assert.strictEqual(transition('valid', 'nonsense_event').changed, false);
});

test('classifyTokenError maps google error bodies', () => {
  assert.strictEqual(classifyTokenError({ error: 'invalid_grant' }), 'refresh_failed');
  assert.strictEqual(classifyTokenError({ error: 'invalid_scope' }), 'scope_missing');
  assert.strictEqual(classifyTokenError({ error: 'temporarily_unavailable' }), null);
});

test('dueForValidation: weekly sweep picks stale, skips revoked', () => {
  const now = Date.parse('2026-08-19T00:00:00Z');
  const conns = [
    { id: 1, status: 'valid', last_validated_at: '2026-08-01T00:00:00Z' },
    { id: 2, status: 'valid', last_validated_at: '2026-08-18T00:00:00Z' },
    { id: 3, status: 'revoked', last_validated_at: '2026-07-01T00:00:00Z' },
    { id: 4, status: 'expired', last_validated_at: null },
  ];
  const due = dueForValidation(conns, now).map((c) => c.id);
  assert.deepStrictEqual(due, [1, 4]);
});
