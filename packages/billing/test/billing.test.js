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

test('webhook: a $0 checkout (100% promotion code) has no PaymentIntent and still unlocks; the session id is the key', async () => {
  const { handleWebhook } = require('../src/webhooks');
  const rows = [];
  const store = { recordPayment: async (r) => rows.push(r), audit: async () => {}, ledger: async () => {}, tenantIdByCustomer: async () => null };
  const r = await handleWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_live_1', mode: 'payment', payment_intent: null, amount_total: 0, customer: 'cus_1', metadata: { tenant_id: 't1', kind: 'audit_unlock' }, discounts: [{ coupon: 'co_1', promotion_code: 'promo_1' }] } } }, store);
  assert.deepStrictEqual(r, { handled: true });
  assert.deepStrictEqual(rows[0], { tenant_id: 't1', kind: 'audit_unlock', stripe_payment_intent: null, stripe_session_id: 'cs_live_1', amount_usd: 0, promotion_code: 'promo_1', stripe_customer_id: 'cus_1' });
});

test('credit is what was paid, capped at $20: a 100% code paid nothing, so no credit and no sentence', () => {
  const { accessFrom } = require('../src/access');
  const base = { sub: null, tenant: { size_band: '4k' }, pricing: null, report: null, pending: [], ads: null };
  const free = accessFrom({ ...base, paid: { kind: 'audit_unlock', amount_usd: 0 } });
  assert.deepStrictEqual([free.level, free.credit_usd, free.credit_applies], ['unlocked', 0, false]);
  const half = accessFrom({ ...base, paid: { kind: 'audit_unlock', amount_usd: 10 } });
  assert.deepStrictEqual([half.credit_usd, half.credit_applies], [10, true]);
  const full = accessFrom({ ...base, paid: { kind: 'audit_unlock' } });
  assert.deepStrictEqual([full.credit_usd, full.credit_applies], [20, true], 'older rows without an amount keep the $20');
});

test('webhook: a completed unlock writes the receipt (History line and email) when the store offers it', async () => {
  const { handleWebhook } = require('../src/webhooks');
  const receipts = [];
  const store = { recordPayment: async () => {}, audit: async () => {}, ledger: async () => {}, tenantIdByCustomer: async () => null, unlockReceipt: async (t, o) => receipts.push([t, o]) };
  await handleWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_intent: 'pi_1', amount_total: 2000, metadata: { tenant_id: 't1', kind: 'audit_unlock' }, customer_details: { email: 'o@x.ae' } } } }, store);
  assert.deepStrictEqual(receipts, [['t1', { amountUsd: 20, kind: 'audit_unlock', email: 'o@x.ae' }]]);
});

test('webhooks: a paid tenant with a Google click id gets one conversion row per Stripe id, renewals excluded (tracking Part C)', async () => {
  const store = mkStore();
  const conversions = [];
  const paidInvoices = [];
  store.tenantAttribution = async () => ({ src: 'launch', trade: 'dentists', gclid: 'Cj0abc' });
  store.recordConversion = async (r) => { if (conversions.some((c) => c.conversion_name === r.conversion_name && c.stripe_id === r.stripe_id)) return; conversions.push(r); };
  store.invoicePaidBefore = async (tenantId, sub, invoice) => paidInvoices.some((p) => p.sub === sub && p.invoice !== invoice);
  store.audit = (e) => { if (e.event === 'invoice_paid') paidInvoices.push({ sub: e.detail.subscription, invoice: e.detail.invoice }); store.calls.audit.push(e); };

  const unlock = { type: 'checkout.session.completed', data: { object: { mode: 'payment', customer: 'cus_1', payment_intent: 'pi_9', amount_total: 0, amount_subtotal: 2000, metadata: { kind: 'audit_unlock' }, id: 'cs_9', created: 1789000000 } } };
  await handleWebhook(unlock, store);
  await handleWebhook(unlock, store); // Stripe retry
  assert.strictEqual(conversions.length, 1);
  assert.deepStrictEqual({ name: conversions[0].conversion_name, gclid: conversions[0].gclid, value: conversions[0].value_usd, id: conversions[0].stripe_id, cur: conversions[0].currency },
    { name: 'report_unlocked', gclid: 'Cj0abc', value: 20, id: 'pi_9', cur: 'USD' }, 'list price, not the $0 paid; the payment intent is the order id');

  await handleWebhook({ type: 'invoice.paid', data: { object: { customer: 'cus_1', subscription: 'sub_7', id: 'in_1', amount_paid: 10900, subtotal: 12900, billing_reason: 'subscription_create' } } }, store);
  await handleWebhook({ type: 'invoice.paid', data: { object: { customer: 'cus_1', subscription: 'sub_7', id: 'in_2', amount_paid: 12900, subtotal: 12900, billing_reason: 'subscription_cycle' } } }, store);
  const subs = conversions.filter((c) => c.conversion_name === 'subscription_started');
  assert.strictEqual(subs.length, 1, 'the renewal is not a second conversion');
  assert.deepStrictEqual({ id: subs[0].stripe_id, value: subs[0].value_usd }, { id: 'sub_7', value: 129 }, 'recurring list price before the $20 credit');

  // No click id: nothing recorded, and the webhook still succeeds.
  const quiet = mkStore();
  quiet.tenantAttribution = async () => ({ src: 'blog' });
  quiet.recordConversion = async () => { throw new Error('should not be called'); };
  const r = await handleWebhook(unlock, quiet);
  assert.strictEqual(r.handled, true);
});
