// Campaign builder — creation as the biggest possible "change"
// (before: nothing → after: this spec). One engine, two registers:
// renderBrief() speaks full technical vocabulary for the agency console,
// renderPlain() speaks the customer register for the consumer surface.
//
// The builder is deterministic and offline: it drafts from inputs the
// platform already has (business name, services, location, existing account
// structure). The Google Ads mutate that turns an approved spec into a real
// campaign lives behind the executor and always creates PAUSED — enabling is
// a second explicit human click. Nothing here talks to Google.

const TEMPLATES = ['brand', 'generic', 'remarketing'];

const slug = (s) => String(s || '').trim().replace(/\s+/g, ' ');

function brandAdGroup({ business }) {
  const name = slug(business);
  return {
    name: 'Brand',
    keywords: [
      { text: `"${name.toLowerCase()}"`, match: 'phrase' },
      { text: `[${name.toLowerCase()}]`, match: 'exact' },
    ],
    negatives: ['jobs', 'careers', 'salary'],
    rsa: {
      headlines: [
        `${name} — Official Site`, `${name}`, 'Book Today', 'Trusted Local Choice',
        'See Prices & Availability', 'Rated by Real Customers', 'Fast Response', 'Get In Touch Now',
      ],
      descriptions: [
        `${name} — the official site. See services, prices and availability, and book in minutes.`,
        'Real reviews, clear prices, quick booking. Get exactly what you searched for.',
        'Questions? Reach us directly — we reply fast.',
        'Book online in under a minute.',
      ],
      pinned: { headline_1: `${name} — Official Site` },
    },
  };
}

function serviceAdGroup({ business, service, location }) {
  const s = slug(service);
  const loc = slug(location);
  const kw = (t, match) => ({ text: match === 'exact' ? `[${t}]` : match === 'phrase' ? `"${t}"` : t, match });
  return {
    name: s,
    keywords: [
      kw(`${s.toLowerCase()}${loc ? ` ${loc.toLowerCase()}` : ''}`, 'phrase'),
      kw(`${s.toLowerCase()} near me`, 'phrase'),
      kw(`best ${s.toLowerCase()}${loc ? ` ${loc.toLowerCase()}` : ''}`, 'phrase'),
    ],
    negatives: ['free', 'diy', 'jobs', 'course', 'training'],
    rsa: {
      headlines: [
        `${s}${loc ? ` in ${loc}` : ''}`, `Book ${s} Today`, `${business} — ${s}`, 'See Prices & Availability',
        'Rated by Real Customers', 'Fast, Friendly Service', 'Easy Online Booking', 'Get a Quote in Minutes',
      ],
      descriptions: [
        `Looking for ${s.toLowerCase()}${loc ? ` in ${loc}` : ''}? ${business} makes booking simple — clear prices, real reviews.`,
        'Book online in under a minute, or message us with any question.',
        'Local, reliable and rated by customers like you.',
        'See availability now — no phone call needed.',
      ],
      pinned: {},
    },
  };
}

/**
 * buildCampaignSpec(input) -> canonical spec
 * input: {
 *   template: 'brand' | 'generic' | 'remarketing',
 *   business: 'Glow Studio',
 *   services: ['Gel nails', ...],          // generic template
 *   location: 'Dubai' | null,
 *   budget_daily_usd: number,
 *   conversion_goal: 'booking_confirmed',  // the key event bidding steers to
 *   existing_campaign_names: [ ... ],      // collision-safe naming
 * }
 */
function buildCampaignSpec(input) {
  const template = TEMPLATES.includes(input.template) ? input.template : 'generic';
  const business = slug(input.business) || 'Your business';
  const location = input.location ? slug(input.location) : null;
  const budget = Number(input.budget_daily_usd) > 0 ? Number(input.budget_daily_usd) : 10;

  let name;
  let adGroups;
  let channel = 'search';
  // New campaigns NEVER launch on Maximise clicks: with a healthy conversion
  // goal we bid to conversions from day one — that's the whole point of
  // fixing measurement first.
  let bidding = 'Maximise conversions';

  if (template === 'brand') {
    name = `Brand — ${business}`;
    adGroups = [brandAdGroup({ business })];
  } else if (template === 'remarketing') {
    name = `Remarketing — ${business}`;
    channel = 'display';
    adGroups = [{
      name: 'Site visitors 30d',
      audience: 'site_visitors_30d',
      keywords: [],
      negatives: [],
      rsa: {
        headlines: [`Still thinking it over?`, `${business}`, 'Come back and book', 'Prices & availability'],
        descriptions: [
          `You looked at ${business} recently — booking takes under a minute.`,
          'Real reviews, clear prices. Pick a time that suits you.',
        ],
        pinned: {},
      },
    }];
  } else {
    const services = (input.services || []).map(slug).filter(Boolean);
    const list = services.length ? services : ['Main service'];
    name = `${list[0]}${location ? ` — ${location}` : ''}`;
    adGroups = list.map((service) => serviceAdGroup({ business, service, location }));
  }

  // Collision-safe naming against the live snapshot.
  const taken = new Set((input.existing_campaign_names || []).map((n) => n.toLowerCase()));
  if (taken.has(name.toLowerCase())) name = `${name} (Insyt draft)`;

  return {
    schema_version: 1,
    template,
    name,
    channel,
    budget_daily_usd: budget,
    bidding,
    conversion_goal: input.conversion_goal || null,
    settings: {
      geo: location || 'account default',
      language: 'account default',
      networks: channel === 'search' ? ['search'] : ['display'],
      start_paused: true, // invariant — the executor refuses anything else
    },
    ad_groups: adGroups,
    tracking_checks: [
      'conversion goal exists and fired in the last 14 days',
      'no duplicate primary conversion actions',
      'final URLs resolve 200 on the live site',
    ],
  };
}

/**
 * validateSpec(spec, health) -> { ok, blockers[] }
 * The builder refuses to ship a campaign onto broken measurement — the
 * brand-defining precondition. health: {
 *   conversionGoalHealthy: bool, billingAttached: bool,
 *   openCriticalTracking: number,
 * }
 */
function validateSpec(spec, health = {}) {
  const blockers = [];
  if (!spec || !spec.name || !spec.ad_groups || !spec.ad_groups.length) {
    blockers.push('Spec is incomplete — no ad groups.');
  }
  if (spec && spec.settings && spec.settings.start_paused !== true) {
    blockers.push('Campaigns must start paused — enabling is a separate explicit action.');
  }
  if (health.conversionGoalHealthy === false) {
    blockers.push('The conversion goal this campaign would bid to is broken or silent — fix tracking first. A campaign born on bad measurement wastes money from hour one.');
  }
  if (health.openCriticalTracking > 0) {
    blockers.push(`${health.openCriticalTracking} critical tracking issue(s) open on this account — resolve them before adding spend.`);
  }
  if (health.billingAttached === false) {
    blockers.push('No billing attached to the Google Ads account — the campaign could be created but never serve.');
  }
  return { ok: blockers.length === 0, blockers };
}

// ---- Renderers: same spec, two registers.

/** Technical brief for the agency console / Copy build brief. */
function renderBrief(spec) {
  const lines = [];
  lines.push(`CAMPAIGN BUILD BRIEF — ${spec.name}`);
  lines.push(`Channel: ${spec.channel} · Budget: $${spec.budget_daily_usd}/day · Bidding: ${spec.bidding}${spec.conversion_goal ? ` → ${spec.conversion_goal}` : ''}`);
  lines.push(`Settings: geo ${spec.settings.geo} · networks ${spec.settings.networks.join('+')} · CREATE PAUSED`);
  for (const ag of spec.ad_groups) {
    lines.push('');
    lines.push(`AD GROUP: ${ag.name}${ag.audience ? ` · audience ${ag.audience}` : ''}`);
    if (ag.keywords.length) lines.push(`  Keywords: ${ag.keywords.map((k) => k.text).join(', ')}`);
    if (ag.negatives.length) lines.push(`  Negatives: ${ag.negatives.join(', ')}`);
    lines.push(`  RSA headlines (${ag.rsa.headlines.length}): ${ag.rsa.headlines.join(' | ')}`);
    lines.push(`  RSA descriptions (${ag.rsa.descriptions.length}): ${ag.rsa.descriptions.join(' | ')}`);
    const pins = Object.entries(ag.rsa.pinned || {});
    if (pins.length) lines.push(`  Pinned: ${pins.map(([p, v]) => `${p}="${v}"`).join(', ')}`);
  }
  lines.push('');
  lines.push(`Pre-flight: ${spec.tracking_checks.join(' · ')}`);
  return lines.join('\n');
}

/** Customer-register summary for the consumer surface. No trade vocabulary. */
function renderPlain(spec) {
  const who = spec.template === 'brand'
    ? 'people searching for your business by name'
    : spec.template === 'remarketing'
      ? 'people who visited your website recently'
      : `people searching for what you offer${spec.settings.geo !== 'account default' ? ` near ${spec.settings.geo}` : ''}`;
  const example = spec.ad_groups[0];
  return {
    headline: `Your ad: ${spec.name}`,
    who_sees_it: `This shows to ${who}.`,
    what_it_says: example ? `${example.rsa.headlines[0]} — ${example.rsa.descriptions[0]}` : '',
    what_you_pay: `Up to $${spec.budget_daily_usd} a day. You only pay when someone clicks. It starts switched off — nothing spends until you say go.`,
    safety_line: 'We checked your setup first, so every click gets counted correctly from day one.',
  };
}

module.exports = { buildCampaignSpec, validateSpec, renderBrief, renderPlain, TEMPLATES };
