// Stripe Checkout + billing-portal sessions — build-doc §10 purchase paths.
// No Stripe SDK: thin form-encoded REST client, injectable fetch for tests.
// Prices are found by metadata.key exactly as scripts/seed-stripe.js created
// them (insyt_audit_unlock, insyt_core_4k_monthly, …).

const API = 'https://api.stripe.com/v1';

// Nested-object form encoding the Stripe API expects
// ({ a: { b: 1 }, c: [ { d: 2 } ] } → a[b]=1&c[0][d]=2).
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

const AUDIT_PRICE_KEYS = {
  audit_unlock: 'insyt_audit_unlock',
  large_audit: 'insyt_audit_large_1',
  large_audit_xl: 'insyt_audit_large_2',
  setup_bundle: 'insyt_setup_bundle',
};

function createStripeCheckout({ secretKey, fetchImpl = fetch }) {
  let priceCache = null; // key -> price id (process lifetime; seed rarely changes)

  async function call(path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? formEncode(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${res.status}: ${(json.error && json.error.message) || 'unknown'}`);
    return json;
  }

  async function priceIdByKey(key) {
    if (!priceCache) {
      priceCache = new Map();
      let startingAfter = null;
      do {
        const page = await call(`/prices?limit=100&active=true${startingAfter ? `&starting_after=${startingAfter}` : ''}`);
        for (const p of page.data || []) {
          if (p.metadata && p.metadata.key) priceCache.set(p.metadata.key, p.id);
        }
        startingAfter = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
      } while (startingAfter);
    }
    const id = priceCache.get(key);
    if (!id) throw new Error(`no Stripe price with key ${key} — run scripts/seed-stripe.js`);
    return id;
  }

  return {
    /** One-time payment (audit unlock / large audit / setup bundle). */
    auditCheckout: async ({ tenantId, kind = 'audit_unlock', customerEmail, successUrl, cancelUrl }) => {
      const priceKey = AUDIT_PRICE_KEYS[kind];
      if (!priceKey) throw new Error(`unknown one-time kind: ${kind}`);
      const session = await call('/checkout/sessions', {
        mode: 'payment',
        line_items: [{ price: await priceIdByKey(priceKey), quantity: 1 }],
        client_reference_id: tenantId,
        customer_email: customerEmail || undefined,
        customer_creation: 'always', // customer id is our webhook join key
        metadata: { tenant_id: tenantId, kind },
        payment_intent_data: { metadata: { tenant_id: tenantId, kind } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return { id: session.id, url: session.url };
    },

    /** Subscription checkout for a tier/band/cadence from the §12 matrix. */
    subscriptionCheckout: async ({ tenantId, tier, band, cadence = 'monthly', customerEmail, successUrl, cancelUrl }) => {
      const session = await call('/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: await priceIdByKey(`insyt_${tier}_${band}_${cadence}`), quantity: 1 }],
        client_reference_id: tenantId,
        customer_email: customerEmail || undefined,
        metadata: { tenant_id: tenantId, kind: 'subscription', tier, band },
        subscription_data: { metadata: { tenant_id: tenantId, tier, band } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return { id: session.id, url: session.url };
    },

    /** Billing portal (card update, cancel) for an existing customer. */
    portalSession: async ({ customerId, returnUrl }) => {
      const session = await call('/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
      return { url: session.url };
    },
  };
}

module.exports = { createStripeCheckout, formEncode, AUDIT_PRICE_KEYS };
