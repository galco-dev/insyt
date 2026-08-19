const assert = require('node:assert');
const { test } = require('node:test');
const { buildAuthUrl, exchangeCode, refreshAccessToken, validateConnection } = require('../src/oauth');

const CREDS = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.tryinsyt.com/oauth/callback' };

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('buildAuthUrl: discovery step is incremental, offline, read-only scopes', () => {
  const url = new URL(buildAuthUrl({ ...CREDS, step: 'discovery', state: 'xyz' }));
  assert.strictEqual(url.searchParams.get('include_granted_scopes'), 'true');
  assert.strictEqual(url.searchParams.get('access_type'), 'offline');
  assert.strictEqual(url.searchParams.get('state'), 'xyz');
  const scope = url.searchParams.get('scope');
  assert.match(scope, /adwords/);
  assert.match(scope, /analytics\.readonly/);
  assert.match(scope, /tagmanager\.readonly/);
  assert.ok(!/edit/.test(scope), 'no write scopes at discovery — asked at first Apply only');
});

test('buildAuthUrl: create step refuses (no scopes to ask)', () => {
  assert.throws(() => buildAuthUrl({ ...CREDS, step: 'create', state: 's' }));
});

test('exchangeCode: success parses tokens and granted scopes', async () => {
  const f = fakeFetch(200, {
    access_token: 'at', refresh_token: 'rt', expires_in: 3600,
    scope: 'openid https://www.googleapis.com/auth/adwords',
  });
  const r = await exchangeCode({ ...CREDS, code: 'c0de' }, f);
  assert.strictEqual(r.tokens.access_token, 'at');
  assert.strictEqual(r.tokens.refresh_token, 'rt');
  assert.strictEqual(r.grantedScopes.length, 2);
  assert.match(f.calls[0].init.body, /grant_type=authorization_code/);
});

test('refreshAccessToken: invalid_grant surfaces as error body', async () => {
  const f = fakeFetch(400, { error: 'invalid_grant' });
  const r = await refreshAccessToken({ ...CREDS, refreshToken: 'dead' }, f);
  assert.strictEqual(r.error.error, 'invalid_grant');
});

test('validateConnection: healthy refresh reports granted scopes', async () => {
  const f = fakeFetch(200, { access_token: 'at', expires_in: 3600, scope: 'a b c' });
  const r = await validateConnection({ refreshToken: 'rt' }, CREDS, f);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.grantedScopes, ['a', 'b', 'c']);
});
