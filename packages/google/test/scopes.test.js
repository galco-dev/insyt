const assert = require('node:assert');
const { test } = require('node:test');
const { SCOPES, LADDER, scopeLevel, missingScopes } = require('../src/scopes');

const RO = [SCOPES.ADWORDS, SCOPES.ANALYTICS_RO, SCOPES.TAGMANAGER_RO];
const WRITE = [...RO, SCOPES.ANALYTICS_EDIT, SCOPES.TAGMANAGER_EDIT, SCOPES.TAGMANAGER_PUBLISH];

test('scopeLevel: full readonly grant', () => {
  assert.strictEqual(scopeLevel(RO), 'readonly');
});

test('scopeLevel: full write grant (create requires no extra scopes in v1)', () => {
  assert.strictEqual(scopeLevel(WRITE), 'create');
});

test('scopeLevel: partial grant yields null (connection goes partial)', () => {
  assert.strictEqual(scopeLevel([SCOPES.ADWORDS, SCOPES.ANALYTICS_RO]), null);
  assert.strictEqual(scopeLevel([]), null);
});

test('missingScopes: names exactly what a partial grant lacks', () => {
  assert.deepStrictEqual(
    missingScopes([SCOPES.ADWORDS, SCOPES.ANALYTICS_RO], 'readonly'),
    [SCOPES.TAGMANAGER_RO],
  );
  assert.deepStrictEqual(missingScopes(WRITE, 'write'), []);
});

test('ladder: discovery asks read-only only; write adds edit+publish; create adds none', () => {
  assert.ok(LADDER.discovery.every((s) => /readonly|adwords/.test(s)));
  assert.ok(LADDER.write.some((s) => /analytics\.edit/.test(s)));
  assert.ok(LADDER.write.some((s) => /tagmanager\.publish/.test(s)));
  assert.deepStrictEqual(LADDER.create, []);
});
