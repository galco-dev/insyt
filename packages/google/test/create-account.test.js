const assert = require('node:assert');
const { test } = require('node:test');
const { createAdsAccount, formatCustomerId } = require('../src/create-account');

test('createAdsAccount: refreshes the manager token, creates the client under the manager, invites the owner as admin', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (/oauth2\.googleapis\.com\/token/.test(url)) return { ok: true, status: 200, json: async () => ({ access_token: 'mgr-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/adwords' }) };
    return { ok: true, status: 200, json: async () => ({ resourceName: 'customers/1234567890', invitationLink: 'https://ads.google.com/invite/x' }) };
  };
  const r = await createAdsAccount({ clientId: 'c', clientSecret: 's', managerRefreshToken: 'rt', developerToken: 'dev', managerId: '331-582-4995', descriptiveName: 'Smile Dental', currency: 'gbp', timeZone: 'Europe/London', ownerEmail: 'owner@smile.com', fetchImpl });
  assert.deepStrictEqual({ id: r.customer_id, f: r.formatted, cur: r.currency, link: r.invitation_link }, { id: '1234567890', f: '123-456-7890', cur: 'GBP', link: 'https://ads.google.com/invite/x' });
  const create = calls[1];
  assert.match(create.url, /customers\/3315824995:createCustomerClient$/);
  assert.equal(create.init.headers['login-customer-id'], '3315824995');
  assert.equal(create.init.headers['developer-token'], 'dev');
  assert.equal(create.init.headers.authorization, 'Bearer mgr-token');
  const body = JSON.parse(create.init.body);
  assert.deepStrictEqual(body.customerClient, { descriptiveName: 'Smile Dental', currencyCode: 'GBP', timeZone: 'Europe/London' });
  assert.deepStrictEqual({ e: body.emailAddress, role: body.accessRole }, { e: 'owner@smile.com', role: 'ADMIN' });
});

test('createAdsAccount: no manager credentials is a plain refusal; an unknown currency falls back to USD; Google errors surface with their code', async () => {
  await assert.rejects(() => createAdsAccount({ clientId: 'c', clientSecret: 's', managerRefreshToken: '', developerToken: 'd', managerId: '1' }), /not configured/);
  const fetchImpl = async (url) => (/token/.test(url)
    ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 60 }) }
    : { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'no' } }) });
  await assert.rejects(() => createAdsAccount({ clientId: 'c', clientSecret: 's', managerRefreshToken: 'rt', developerToken: 'd', managerId: '1', currency: 'XXX', fetchImpl }), (e) => e.code === 'PERMISSION_DENIED');
  assert.equal(formatCustomerId('1234567890'), '123-456-7890');
});
