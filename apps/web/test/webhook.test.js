const assert = require('node:assert');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { createApp } = require('../src/server');
const { handleWebhook } = require('../../../packages/billing/src/webhooks');

const okCrawler = { discoveryCrawl: async () => ({ status: 'complete', tags_found: {} }) };
const baseStore = () => ({
  createCrawl: () => '1', getCrawl: () => null, patchCrawl: () => {}, crawlCountForDomain: () => 0,
  getReportHtml: () => null, magicLinks: { insertLink: () => {}, findByHash: () => null, markUsed: () => {} },
});

async function withApp(deps, fn) {
  const app = createApp(deps);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { app.close(); }
}

const SECRET = 'whsec_test';
const signed = (payload) => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
};

function billingDeps() {
  const calls = [];
  return {
    calls,
    handleWebhook,
    webhookSecret: SECRET,
    store: {
      upsertSubscription: (r) => calls.push(['sub', r]),
      markSubscription: (id, p) => calls.push(['mark', id, p]),
      recordPayment: (r) => calls.push(['pay', r]),
      ledger: (e) => calls.push(['ledger', e]),
      audit: (e) => calls.push(['audit', e]),
      scheduleEmail: (t, tn, v) => calls.push(['email', t]),
      tenantIdByCustomer: () => 'tn1',
    },
  };
}

test('stripe webhook: valid signature processes the event', async () => {
  const billing = billingDeps();
  await withApp({ store: baseStore(), crawler: okCrawler, billing }, async (base) => {
    const payload = JSON.stringify({ type: 'invoice.paid', data: { object: { customer: 'cus_1', subscription: 'sub_1', id: 'in_1', amount_paid: 12900 } } });
    const res = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST', headers: { 'stripe-signature': signed(payload) }, body: payload,
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { received: true, handled: true });
    assert.ok(billing.calls.some((c) => c[0] === 'mark' && c[2].status === 'active'));
  });
});

test('stripe webhook: bad signature rejected, nothing processed', async () => {
  const billing = billingDeps();
  await withApp({ store: baseStore(), crawler: okCrawler, billing }, async (base) => {
    const payload = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
    const res = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST', headers: { 'stripe-signature': 't=1,v1=deadbeef' }, body: payload,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(billing.calls.length, 0);
  });
});
