// Layer 2 — GA4 config rules (build-doc §3).
// Input: a normalised GA4 property snapshot from the Admin API, fetched at
// the fetch_ga4_config pipeline stage (§8). Shape:
//
// ctx.ga4 = {
//   property_id: '333222111',
//   key_events: [{ name, event_name, counting_method, create_time }],
//   ads_links: [{ customer_id, create_time }],
//   retention_months: 2 | 14 | ...,
//   enhanced_measurement: { enabled, events: ['page_view','scroll','click',...] },
//   attribution: { model, is_default, changed_at | null },
// }
// ctx.gtm — the Layer 1 container snapshot (for enhanced_double_fire we need
//   GA4 event tags: tags with type 'gaawe' and their event_name)
// ctx.linkedAdsCustomerIds — confirmed ads_account external_ids for the tenant
// ctx.conversionWindowDays — account conversion window (default 30)
// ctx.now — ms epoch, injected
//
// Severity comes from rule_config (06 seed); partial findings only here.

// Events that exist on every GA4 property automatically — marking one as a
// key event means "conversions" that are really just visits.
const NON_BUSINESS_EVENTS = new Set([
  'page_view', 'session_start', 'first_visit', 'scroll', 'user_engagement', 'view_search_results',
]);

const rules = [
  {
    rule_id: 'ga4.no_key_events',
    layer: 2,
    run({ ga4 }) {
      if ((ga4.key_events || []).length > 0) return [];
      return [{
        category: 'broken_tracking',
        entity_key: ga4.property_id,
        evidence: { metrics: { key_event_count: 0 }, window_days: 0, queries: ['ga4/rules/no_key_events@v1'] },
        payload: {
          locked: true,
          entities: [],
          fix_detail: 'Nothing on your site is being counted as a customer action — Google has no idea which clicks turn into business.',
        },
        fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
        icon: 'target',
      }];
    },
  },

  {
    rule_id: 'ga4.key_event_wrong',
    layer: 2,
    // Key event exists but maps to a non-business event (e.g. page_view).
    run({ ga4 }) {
      return (ga4.key_events || [])
        .filter((k) => NON_BUSINESS_EVENTS.has(k.event_name))
        .map((k) => ({
          category: 'broken_tracking',
          entity_key: `${ga4.property_id}:${k.event_name}`,
          evidence: { metrics: { key_event_count: ga4.key_events.length }, window_days: 0, queries: ['ga4/rules/key_event_wrong@v1'] },
          payload: {
            locked: true,
            entities: [{ kind: 'key_event', value: k.event_name }],
            fix_detail: `"${k.event_name}" counts as a customer action, but it fires on every visit — your conversion numbers are inflated and Google optimises toward the wrong thing.`,
          },
          fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
          icon: 'crosshair',
        }));
    },
  },

  {
    rule_id: 'ga4.ads_link_missing',
    layer: 2,
    // No Google Ads link — Ads can't see conversions at all.
    run({ ga4, linkedAdsCustomerIds }) {
      if ((linkedAdsCustomerIds || []).length === 0) return []; // no Ads account confirmed — Journey B/C ground
      if ((ga4.ads_links || []).length > 0) return [];
      return [{
        category: 'broken_tracking',
        entity_key: ga4.property_id,
        evidence: { metrics: { ads_link_count: 0 }, window_days: 0, queries: ['ga4/rules/ads_link_missing@v1'] },
        payload: {
          locked: true,
          entities: [],
          fix_detail: 'Your visit tracking and your ads account are not connected — what happens after the click never reaches Google Ads.',
        },
        fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
        icon: 'unlink',
      }];
    },
  },

  {
    rule_id: 'ga4.ads_link_recent',
    layer: 2,
    // Link created < conversion window ago — explains missing history, info only.
    run({ ga4, conversionWindowDays = 30, now }) {
      return (ga4.ads_links || [])
        .filter((l) => l.create_time && (now - Date.parse(l.create_time)) / 86_400_000 < conversionWindowDays)
        .map((l) => ({
          category: 'context',
          entity_key: `${ga4.property_id}:${l.customer_id}`,
          evidence: {
            metrics: { link_age_days: Math.floor((now - Date.parse(l.create_time)) / 86_400_000) },
            window_days: conversionWindowDays,
            queries: ['ga4/rules/ads_link_recent@v1'],
          },
          payload: {
            locked: false, // pure context — nothing to sell here
            entities: [{ kind: 'ads_link', value: l.customer_id }],
            fix_detail: 'The connection between tracking and ads is new — conversion history before it simply does not exist. Expect numbers to look thin for a few weeks.',
          },
          icon: 'clock',
        }));
    },
  },

  {
    rule_id: 'ga4.retention_short',
    layer: 2,
    // Data retention at the 2-month default throws history away.
    run({ ga4 }) {
      if ((ga4.retention_months ?? 14) >= 14) return [];
      return [{
        category: 'config_hygiene',
        entity_key: ga4.property_id,
        evidence: { metrics: { retention_months: ga4.retention_months }, window_days: 0, queries: ['ga4/rules/retention_short@v1'] },
        payload: {
          locked: true,
          entities: [],
          fix_detail: `Your visitor history is deleted after ${ga4.retention_months} months — one setting keeps 14 months instead, for free.`,
        },
        fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
        icon: 'database',
      }];
    },
  },

  {
    rule_id: 'ga4.enhanced_double_fire',
    layer: 2,
    // Enhanced measurement + a GTM tag both sending the same event.
    run({ ga4, gtm }) {
      if (!ga4.enhanced_measurement || !ga4.enhanced_measurement.enabled) return [];
      const enhanced = new Set(ga4.enhanced_measurement.events || []);
      const dupes = (gtm && gtm.tags ? gtm.tags : [])
        .filter((t) => t.type === 'gaawe' && !t.paused && t.event_name && enhanced.has(t.event_name));
      if (dupes.length === 0) return [];
      return [{
        category: 'double_counting',
        entity_key: `${ga4.property_id}:enhanced`,
        evidence: {
          metrics: { double_fired_events: dupes.length },
          window_days: 0,
          queries: ['ga4/rules/enhanced_double_fire@v1'],
        },
        payload: {
          locked: true,
          entities: dupes.map((t) => ({ kind: 'event', value: t.event_name, tag: t.name })),
          fix_detail: `${dupes.length} event(s) are recorded twice — once automatically, once by your tag setup. Your numbers are inflated.`,
        },
        fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
        icon: 'copy',
      }];
    },
  },

  {
    rule_id: 'ga4.attribution_nonstandard',
    layer: 2,
    // Attribution model changed from default without recent history. Brief-only.
    run({ ga4, thresholds, now }) {
      const attr = ga4.attribution;
      if (!attr || attr.is_default) return [];
      const recentDays = thresholds.recent_change_days ?? 90;
      const changedRecently = attr.changed_at && (now - Date.parse(attr.changed_at)) / 86_400_000 <= recentDays;
      if (changedRecently) return []; // deliberate recent choice — leave it alone
      return [{
        category: 'context',
        entity_key: `${ga4.property_id}:attribution`,
        evidence: { metrics: {}, window_days: recentDays, queries: ['ga4/rules/attribution_nonstandard@v1'] },
        payload: {
          locked: false,
          entities: [{ kind: 'attribution_model', value: attr.model }],
          fix_detail: 'Credit for conversions is being split in a non-standard way — worth knowing when comparing your numbers to anything else.',
        },
        icon: 'git-branch',
      }];
    },
  },
];

module.exports = { rules, NON_BUSINESS_EVENTS };
