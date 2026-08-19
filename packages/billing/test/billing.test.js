const assert = require('node:assert');
const { test } = require('node:test');
const { catalogueFromConfig, seedCatalogue } = require('../src/catalogue');
const { handleWebhook } = require('../src/webhooks');

const CONFIG = {
  matrix: { core: { '4k': 129, '10k': 179, '25k': 249 }, autopilot: { '4k': 199, '10k': 279, '25k': 389 }, scale: { '4k': 399, '10k': 499, '25k': 649 } },
  audit_fees: { standard: 20, large: [49, 79] },
  bundle_usd: 199,
};

test('catalogue: 3 products x 6 prices (3 bands x monthly/annual) + 4 one-time; annual = 10x monthly', () => {
  const { products, oneTime } = catalogueFromConfig(CONFIG);
  assert.strictEqual(products.length, 3);
  assert.ok(products.every((p) => p.prices.length === 6));
  assert.strictEqual(oneTime.length, 4);
  const coreAnnual4k = products[0].prices.find((p) => p.key === 'insyt_core_4k_annual');
  assert.strictEqual(coreAnnual4k.unit_amount, 129 * 10 * 100);
  assert.strictEqual(coreAnnual4k.recurring.interval, 'year');
  const unlock = oneTime.find((p) => p.key === 'insyt_audit_unlock');
  assert.strictEqual(unlock.unit_amount, 2000);
});

function fakeStripe(pre = { products: [], pricesByProduct: {} }) {
  let nextId = 1;
  const created = { products: [], prices: [] };
  return {
    created,
    products: {
      list: async () => ({ data: [...pre.products, ...created.products] }),
      create: async (f) => { const p = { id: `prod_${nextId++}`, metadata: f.metadata }; created.products.push(p); return p; },
    },
    prices: {
      list: async ({ product }) => ({ data: [...(pre.pricesByProduct[product] || []), ...created.prices.filter((pr) => pr.product === product)] }),
      create: async (f) => { const pr = { id: `price_${nextId++}`, ...f }; created.prices.push(pr); return pr; },
    },
  };
}

test('seedCatalogue: creates 7 products + 22 prices from nothing; second run creates nothing', async () => {
  const stripe = fakeStripe();
  const first = await seedCatalogue(stripe, CONFIG);
  assert.deepStrictEqual(first, { products: 7, prices: 22 }); // 3 tier products + 4 one-time; 18 recurring + 4 one-time prices
  const again = await seedCatalogue(stripe, CONFIG);
  assert.deepStrictEqual(again, { products: 0, prices: 0 }, 'idempotent');
});

function mkStore() {
  const calls = { subs: [], marks: [], payments: [], ledger: [], audit: [], emails: [] };
  return {
    calls,
    upsertSubscription: (r) => calls.subs.push(r),
    markSubscription: (id, patch) => calls.marks.push({ id, ...patch }),
    recordPayment: (r) => calls.payments.push(r),
    ledger: (e) => calls.ledger.push(e),
    audit: (e) => calls.audit.push(e),
    scheduleEmail: (template_id, tenant_id, vars) => calls.emails.push({ template_id, tenant_id, ...vars }),
    tenantIdByCustomer: () => 'tn1',
  };
}

test('webhooks: subscription mirror, payment record, grace ladder degrades never cuts', async () => {
  const store = mkStore();
  await handleWebhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { tier: 'core', band: '4k' }, items: { data: [{ price: { unit_amount: 12900 } }] }, current_period_end: 1766000000 } } }, store);
  assert.strictEqual(store.calls.subs[0].price_usd, 129);
  assert.strictEqual(store.calls.ledger[0].event, 'subscription_changed');

  await handleWebhook({ type: 'checkout.session.completed', data: { object: { mode: 'payment', customer: 'cus_1', payment_intent: 'pi_1', amount_total: 2000, metadata: { kind: 'audit_unlock' }, id: 'cs_1' } } }, store);
  assert.strictEqual(store.calls.payments[0].amount_usd, 20);

  await handleWebhook({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_1', subscription: 'sub_1', attempt_count: 2, id: 'in_1' } } }, store);
  assert.deepStrictEqual(store.calls.marks.at(-1), { id: 'sub_1', status: 'past_due' }, 'degraded, not cancelled');
  assert.strictEqual(store.calls.emails[0].template_id, 'card_failed_grace');
  assert.strictEqual(store.calls.emails[0].next_retry_days, 5, 'attempt 2 -> 5-day retry');

  const unknown = await handleWebhook({ type: 'weird.event', data: { object: {} } }, store);
  assert.strictEqual(unknown.handled, false);
});
