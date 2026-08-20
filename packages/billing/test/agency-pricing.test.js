// Agency pricing: whole-portfolio banding, band edges, proration, cycle maths,
// and the 1 → 10 → 20 → 35 scaling journey.
const assert = require('node:assert');
const { test } = require('node:test');
const { bandRate, monthlyCharge, prorateAdd, cycleFor } = require('../src/agency-pricing');

test('band edges: 10/11 and 30/31 re-price the whole portfolio', () => {
  assert.strictEqual(bandRate(1), 45);
  assert.strictEqual(bandRate(10), 45);
  assert.strictEqual(bandRate(11), 39);
  assert.strictEqual(bandRate(30), 39);
  assert.strictEqual(bandRate(31), 35);
  assert.strictEqual(bandRate(60), 35);
});

test('scaling journey: 1 test account → 10 → 20 → 35, mid tier', () => {
  // Starts with one account to test.
  assert.deepStrictEqual(monthlyCharge(1, 'mid'), {
    accounts: 1, rate: 45, band: '1–10', accountsSum: 45, platformFee: 249, total: 294,
  });
  // Adds up to 10 — still band one.
  assert.strictEqual(monthlyCharge(10, 'mid').total, 10 * 45 + 249);
  // The 11th account drops EVERY account to $39 (total goes 699 → 678).
  assert.strictEqual(monthlyCharge(10, 'mid').total, 699);
  assert.strictEqual(monthlyCharge(11, 'mid').total, 11 * 39 + 249); // 678
  assert.ok(monthlyCharge(11, 'mid').total < monthlyCharge(10, 'mid').total, 'band drop is celebrated');
  // 20 accounts.
  assert.strictEqual(monthlyCharge(20, 'mid').total, 20 * 39 + 249);
  // 35 accounts: whole portfolio at $35.
  assert.strictEqual(monthlyCharge(35, 'mid').total, 35 * 35 + 249);
});

test('platform tiers price independently of account count', () => {
  assert.strictEqual(monthlyCharge(20, 'base').platformFee, 149);
  assert.strictEqual(monthlyCharge(20, 'mid').platformFee, 249);
  assert.strictEqual(monthlyCharge(20, 'top').platformFee, 399);
  assert.throws(() => monthlyCharge(20, 'gold'));
});

test('zero billable accounts bills the platform fee only', () => {
  const c = monthlyCharge(0, 'base');
  assert.strictEqual(c.accountsSum, 0);
  assert.strictEqual(c.total, 149);
});

test('proration: mid-cycle add charges remaining days at the post-add band', () => {
  // 15 of 30 days left, add makes it 5 accounts → $45 band → $22.50.
  assert.strictEqual(prorateAdd({ countAfterAdd: 5, daysRemaining: 15, daysInPeriod: 30 }), 22.5);
  // Add that crosses the band: 11th account → $39 rate on the prorated charge.
  assert.strictEqual(prorateAdd({ countAfterAdd: 11, daysRemaining: 10, daysInPeriod: 30 }), 13);
  // Same-day add near cycle end.
  assert.strictEqual(prorateAdd({ countAfterAdd: 3, daysRemaining: 0, daysInPeriod: 30 }), 0);
  // daysRemaining can never exceed the period.
  assert.strictEqual(prorateAdd({ countAfterAdd: 2, daysRemaining: 45, daysInPeriod: 30 }), 45);
});

test('cycle maths from an anchor date', () => {
  const c = cycleFor('2026-08-05', '2026-08-20T12:00:00Z');
  assert.strictEqual(c.start, '2026-08-05');
  assert.strictEqual(c.end, '2026-09-05');
  assert.strictEqual(c.daysInPeriod, 31);
  assert.strictEqual(c.daysRemaining, 16);
  // Anchor day beyond a short month clamps.
  const feb = cycleFor('2026-01-31', '2026-02-10T00:00:00Z');
  assert.strictEqual(feb.start, '2026-01-31');
  assert.strictEqual(feb.end, '2026-02-28');
});
