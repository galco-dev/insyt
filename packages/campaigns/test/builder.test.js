// Campaign builder — spec shape, precondition blockers, register split.
const assert = require('node:assert');
const { test } = require('node:test');
const { buildCampaignSpec, validateSpec, renderBrief, renderPlain } = require('../src/builder');

const base = {
  business: 'Glow Studio',
  location: 'Dubai',
  budget_daily_usd: 12,
  conversion_goal: 'booking_confirmed',
  existing_campaign_names: ['Gel & Extensions', 'Lashes'],
};

test('brand template: exact+phrase brand keywords, pinned official headline, paused', () => {
  const spec = buildCampaignSpec({ ...base, template: 'brand' });
  assert.strictEqual(spec.name, 'Brand — Glow Studio');
  assert.strictEqual(spec.settings.start_paused, true);
  assert.strictEqual(spec.bidding, 'Maximise conversions'); // never clicks
  const kw = spec.ad_groups[0].keywords.map((k) => k.match).sort();
  assert.deepStrictEqual(kw, ['exact', 'phrase']);
  assert.ok(spec.ad_groups[0].rsa.headlines.length >= 8);
  assert.ok(spec.ad_groups[0].rsa.pinned.headline_1.includes('Official'));
});

test('generic template: one ad group per service, collision-safe naming', () => {
  const spec = buildCampaignSpec({ ...base, template: 'generic', services: ['Gel nails', 'Lash lifts'] });
  assert.strictEqual(spec.ad_groups.length, 2);
  assert.ok(spec.ad_groups[0].keywords.some((k) => k.text.includes('near me')));
  // Name collides with an existing campaign → suffixed, never overwrites.
  const clash = buildCampaignSpec({ ...base, template: 'generic', services: ['Gel & Extensions'], location: null });
  assert.strictEqual(clash.name, 'Gel & Extensions (Insyt draft)');
});

test('remarketing template: display channel, audience ad group', () => {
  const spec = buildCampaignSpec({ ...base, template: 'remarketing' });
  assert.strictEqual(spec.channel, 'display');
  assert.strictEqual(spec.ad_groups[0].audience, 'site_visitors_30d');
});

test('validateSpec blocks on broken measurement — the brand-defining precondition', () => {
  const spec = buildCampaignSpec({ ...base, template: 'brand' });
  assert.strictEqual(validateSpec(spec, { conversionGoalHealthy: true, billingAttached: true, openCriticalTracking: 0 }).ok, true);

  const broken = validateSpec(spec, { conversionGoalHealthy: false });
  assert.strictEqual(broken.ok, false);
  assert.ok(broken.blockers[0].includes('fix tracking first'));

  const critical = validateSpec(spec, { openCriticalTracking: 2 });
  assert.ok(critical.blockers.some((b) => b.includes('critical tracking')));

  // Tampered spec that tries to launch enabled is refused.
  const tampered = { ...spec, settings: { ...spec.settings, start_paused: false } };
  assert.ok(validateSpec(tampered, {}).blockers.some((b) => b.includes('start paused')));
});

test('renderBrief carries the full technical spec', () => {
  const brief = renderBrief(buildCampaignSpec({ ...base, template: 'brand' }));
  assert.ok(brief.includes('AD GROUP: Brand'));
  assert.ok(brief.includes('RSA headlines (8)'));
  assert.ok(brief.includes('CREATE PAUSED'));
  assert.ok(brief.includes('Negatives: jobs, careers, salary'));
});

test('renderPlain speaks the customer register — no trade vocabulary', () => {
  const specs = ['brand', 'generic', 'remarketing'].map((template) => buildCampaignSpec({ ...base, template, services: ['Gel nails'] }));
  const BLOCKLIST = [/\bcontainers?\b/i, /\bsnippets?\b/i, /\bproperty\b/i, /\bconversion actions?\b/i, /\bmeasurement id\b/i,
    /\bRSA\b/, /\bad group\b/i, /\bkeywords?\b/i, /\bbidding\b/i, /\bcampaign\b/i];
  for (const spec of specs) {
    const plain = renderPlain(spec);
    const text = Object.values(plain).join(' ');
    for (const re of BLOCKLIST) assert.ok(!re.test(text), `plain register leaked ${re} in: ${text}`);
    assert.ok(plain.what_you_pay.includes('starts switched off'));
  }
});
