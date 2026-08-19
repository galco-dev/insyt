#!/usr/bin/env node
// Seed the Insyt Stripe catalogue from pricing_config — build-doc §10.
// Run with TEST keys first: STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe.js
// Idempotent: identity is metadata.key; re-running creates only what's missing.
// (The Cowork Stripe connector reaches livemode only — this script is the
// test-mode path, per the build-state environment notes.)

const { seedCatalogue } = require('../packages/billing/src/catalogue');

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('STRIPE_SECRET_KEY required (use sk_test_... first)'); process.exit(1); }
  if (!key.startsWith('sk_test_') && process.env.INSYT_ALLOW_LIVE !== '1') {
    console.error('Refusing live keys without INSYT_ALLOW_LIVE=1'); process.exit(1);
  }
  // Minimal Stripe REST client — no SDK dependency.
  const call = async (method, path, form) => {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(flatten(form)).toString() : undefined,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ? body.error.message : `stripe ${res.status}`);
    return body;
  };
  const flatten = (obj, prefix = '') => Object.entries(obj).reduce((acc, [k, v]) => {
    const key2 = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') Object.assign(acc, flatten(v, key2));
    else if (v !== undefined) acc[key2] = String(v);
    return acc;
  }, {});
  const stripe = {
    products: { list: (q) => call('GET', `products?limit=${q.limit}`), create: (f) => call('POST', 'products', f) },
    prices: {
      list: (q) => call('GET', `prices?limit=${q.limit}${q.product ? `&product=${q.product}` : ''}`),
      create: (f) => call('POST', 'prices', f),
    },
  };

  // pricing_config row — mirror of the seeded DB row (§12 launch matrix).
  const pricingConfig = {
    matrix: { core: { '4k': 129, '10k': 179, '25k': 249 }, autopilot: { '4k': 199, '10k': 279, '25k': 389 }, scale: { '4k': 399, '10k': 499, '25k': 649 } },
    audit_fees: { standard: 20, large: [49, 79] },
    bundle_usd: 199,
  };

  const created = await seedCatalogue(stripe, pricingConfig);
  console.log(`stripe seed complete: +${created.products} products, +${created.prices} prices`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
