// Stripe catalogue — build-doc §10. Everything derives from pricing_config
// (the §12 matrix as DATA); this module turns a pricing_config row into the
// exact set of Stripe objects, and the seeding script (scripts/seed-stripe.js)
// creates them idempotently. Products prefixed insyt_, statement descriptor
// INSYT — Insyt is a separate business on the existing Stripe account.

const TIERS = ['core', 'autopilot', 'scale'];
const BANDS = ['4k', '10k', '25k'];

/** Expand a pricing_config row into product + price specs. */
function catalogueFromConfig(pricingConfig) {
  const { matrix, audit_fees, bundle_usd } = pricingConfig;
  const products = TIERS.map((tier) => ({
    key: `insyt_${tier}`,
    name: `Insyt ${tier[0].toUpperCase()}${tier.slice(1)}`,
    prices: BANDS.flatMap((band) => {
      const monthly = matrix[tier][band];
      return [
        { key: `insyt_${tier}_${band}_monthly`, unit_amount: monthly * 100, currency: 'usd', recurring: { interval: 'month' }, metadata: { tier, band, cadence: 'monthly' } },
        // Annual = 2 months free (master §12): 10x monthly, billed yearly.
        { key: `insyt_${tier}_${band}_annual`, unit_amount: monthly * 10 * 100, currency: 'usd', recurring: { interval: 'year' }, metadata: { tier, band, cadence: 'annual' } },
      ];
    }),
  }));
  const oneTime = [
    { key: 'insyt_audit_unlock', name: 'Insyt audit unlock', unit_amount: audit_fees.standard * 100, currency: 'usd' },
    { key: 'insyt_audit_large_1', name: 'Insyt large-account audit', unit_amount: audit_fees.large[0] * 100, currency: 'usd' },
    { key: 'insyt_audit_large_2', name: 'Insyt large-account audit (XL)', unit_amount: audit_fees.large[1] * 100, currency: 'usd' },
    { key: 'insyt_setup_bundle', name: 'Insyt setup bundle (build + first month)', unit_amount: bundle_usd * 100, currency: 'usd' },
  ];
  return { products, oneTime };
}

/**
 * Idempotent seeding against an injected Stripe-like client:
 *   stripe.products.{list,create}, stripe.prices.{list,create}
 * Uses metadata.key as the identity — safe to re-run after config changes
 * (new price objects are versioned per §10; old ones left in place).
 */
async function seedCatalogue(stripe, pricingConfig) {
  const { products, oneTime } = catalogueFromConfig(pricingConfig);
  const created = { products: 0, prices: 0 };

  const existingProducts = (await stripe.products.list({ limit: 100 })).data;
  const productIdByKey = new Map(existingProducts.map((p) => [p.metadata && p.metadata.key, p.id]));

  for (const spec of products) {
    let productId = productIdByKey.get(spec.key);
    if (!productId) {
      const p = await stripe.products.create({ name: spec.name, metadata: { key: spec.key } });
      productId = p.id; created.products += 1;
    }
    const existingPrices = (await stripe.prices.list({ product: productId, limit: 100 })).data;
    const have = new Set(existingPrices.map((pr) => pr.metadata && pr.metadata.key));
    for (const price of spec.prices) {
      if (have.has(price.key)) continue;
      await stripe.prices.create({
        product: productId, unit_amount: price.unit_amount, currency: price.currency,
        recurring: price.recurring, metadata: { key: price.key, ...price.metadata },
      });
      created.prices += 1;
    }
  }

  for (const spec of oneTime) {
    let productId = productIdByKey.get(spec.key);
    if (!productId) {
      const p = await stripe.products.create({ name: spec.name, metadata: { key: spec.key } });
      productId = p.id; created.products += 1;
    }
    const existingPrices = (await stripe.prices.list({ product: productId, limit: 100 })).data;
    if (!existingPrices.some((pr) => pr.metadata && pr.metadata.key === spec.key)) {
      await stripe.prices.create({ product: productId, unit_amount: spec.unit_amount, currency: spec.currency, metadata: { key: spec.key } });
      created.prices += 1;
    }
  }

  return created;
}

module.exports = { catalogueFromConfig, seedCatalogue, TIERS, BANDS };
