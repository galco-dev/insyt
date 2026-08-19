const assert = require('node:assert');
const { test } = require('node:test');
const { routeJourney, sizeBand, auditFee } = require('../src/route');

const ads = { kind: 'ads_account' };
const ga4 = { kind: 'ga4_property' };
const stream = { kind: 'ga4_stream' };
const gtm = { kind: 'gtm_container' };

test('routing table: A / C / B / B-variant (master §6)', () => {
  assert.strictEqual(routeJourney({ confirmed: [ads, ga4, stream, gtm], cmsFingerprint: 'wordpress' }).journey, 'A');
  assert.strictEqual(routeJourney({ confirmed: [ads], cmsFingerprint: 'wordpress' }).journey, 'C');
  const b = routeJourney({ confirmed: [], cmsFingerprint: 'shopify' });
  assert.strictEqual(b.journey, 'B');
  assert.strictEqual(b.first_payment, 'bundle');
  const bv = routeJourney({ confirmed: [ga4, gtm], cmsFingerprint: 'webflow' });
  assert.strictEqual(bv.journey, 'B');
  assert.strictEqual(bv.variant, 'launch_plan_plus_tracking_audit');
});

test('first payment: audit unlock for A and C', () => {
  assert.strictEqual(routeJourney({ confirmed: [ads, ga4, gtm], cmsFingerprint: 'wix' }).first_payment, 'audit_unlock');
  assert.strictEqual(routeJourney({ confirmed: [ads], cmsFingerprint: 'wix' }).first_payment, 'audit_unlock');
});

test('unsupported CMS closes build journeys politely, pre-payment', () => {
  const r = routeJourney({ confirmed: [], cmsFingerprint: 'unsupported' });
  assert.strictEqual(r.close, true);
  assert.strictEqual(r.close_reason, 'unsupported_cms');
  // Journey A needs no build — unsupported CMS does NOT close it.
  assert.strictEqual(routeJourney({ confirmed: [ads, ga4, gtm], cmsFingerprint: 'unsupported' }).close, false);
});

test('dormant variant: $0 spend in 90d routes to reactivation framing', () => {
  const r = routeJourney({ confirmed: [ads, ga4, gtm], cmsFingerprint: 'wordpress', adsActivity: { spend90dUsd: 0 } });
  assert.strictEqual(r.journey, 'A');
  assert.strictEqual(r.variant, 'dormant');
  const active = routeJourney({ confirmed: [ads, ga4, gtm], cmsFingerprint: 'wordpress', adsActivity: { spend90dUsd: 4200 } });
  assert.strictEqual(active.variant, null);
});

test('size bands follow §12 spend bands', () => {
  assert.strictEqual(sizeBand(1200), '4k');
  assert.strictEqual(sizeBand(9000), '10k');
  assert.strictEqual(sizeBand(24000), '25k');
});

test('size gate: standard $20 vs large $49/$79 by review volume', () => {
  assert.deepStrictEqual(auditFee({ searchTermRows90d: 3000, spend30dUsd: 2500 }), { kind: 'audit_unlock', amount_usd: 20 });
  assert.deepStrictEqual(auditFee({ searchTermRows90d: 22000, spend30dUsd: 6000 }), { kind: 'large_audit', amount_usd: 49 });
  assert.deepStrictEqual(auditFee({ searchTermRows90d: 80000, spend30dUsd: 30000 }), { kind: 'large_audit', amount_usd: 79 });
  // spend alone can trip the gate even with few rows
  assert.strictEqual(auditFee({ searchTermRows90d: 500, spend30dUsd: 12000 }).kind, 'large_audit');
});
