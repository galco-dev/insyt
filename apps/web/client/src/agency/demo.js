// Agency demo data — a fictional mid-size agency (Northlight Digital, Dubai)
// with 8 managed accounts. Register: full technical vocabulary; this surface
// is exempt from the customer jargon lint (agency reader checks the working).

export const AGENCY_DEMO = {
  'GET /api/agency/me': {
    seat: { id: 's1', agency_id: 'ag1', role: 'admin', name: 'Ana Barros', email: 'ana@northlight.ae' },
    agency: { id: 'ag1', name: 'Northlight Digital', platform_tier: 'mid', audit_credits_monthly: 5 },
  },
  'GET /api/agency/portfolio': {
    accounts: [
      { id: 'a1', name: 'Glow Studio', manager: 'Mo Haddad', health: 46, open_findings: 9, critical: 3, pending_changes: 4, reports_awaiting_review: 1, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
      { id: 'a2', name: 'Marina Dental', manager: 'Mo Haddad', health: 52, open_findings: 7, critical: 2, pending_changes: 3, reports_awaiting_review: 1, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
      { id: 'a3', name: 'Falcon Movers', manager: 'Ana Barros', health: 61, open_findings: 5, critical: 1, pending_changes: 2, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: true, register: 'technical' },
      { id: 'a4', name: 'Oasis Fitness', manager: 'Rita Kim', health: 66, open_findings: 4, critical: 1, pending_changes: 1, reports_awaiting_review: 1, last_report_at: '2026-08-16T07:00:00Z', brief_only: false, register: 'simple' },
      { id: 'a5', name: 'Palm Interiors', manager: 'Rita Kim', health: 74, open_findings: 3, critical: 0, pending_changes: 2, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
      { id: 'a6', name: 'Desert Rose Spa', manager: 'Mo Haddad', health: 78, open_findings: 2, critical: 0, pending_changes: 0, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
      { id: 'a7', name: 'Bluewater Yachts', manager: 'Ana Barros', health: 83, open_findings: 2, critical: 0, pending_changes: 0, reports_awaiting_review: 0, last_report_at: '2026-08-15T07:00:00Z', brief_only: true, register: 'technical' },
      { id: 'a8', name: 'Cedar Kitchen', manager: 'Rita Kim', health: 88, open_findings: 1, critical: 0, pending_changes: 0, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
    ],
  },
  'GET /api/agency/triage': {
    queue: [
      { id: 'chg-11', account: 'Glow Studio', brief_only: false, severity: 'critical', layer: 4, rule_id: 'ads.dual_primary', title: 'Dual primary conversion actions double-counting purchases', explanation: 'GA4 key event "booking_confirmed" and the website tag "book_now_click" are both primary. Smart bidding optimises to ~2× true conversions.', money_monthly_usd: 430, before: { primary: ['booking_confirmed', 'book_now_click'] }, after: { primary: ['booking_confirmed'], secondary: ['book_now_click'] } },
      { id: 'chg-12', account: 'Marina Dental', brief_only: false, severity: 'critical', layer: 3, rule_id: 'ga4.event_never_fired', title: 'Key event configured in GTM but never observed in GA4 (14 days)', explanation: 'Tag "appointment_booked" exists in the container, zero events in the GA4 stream since the 4 Aug container publish. Trigger references a CSS selector removed from the booking page.', money_monthly_usd: 390, before: { trigger: '.btn-book-v1 click' }, after: { trigger: '.booking-submit click (verified present)' } },
      { id: 'chg-13', account: 'Falcon Movers', brief_only: true, severity: 'warning', layer: 1, rule_id: 'gtm.duplicate_ga4_config', title: 'Duplicate GA4 config tags firing on all pages', explanation: 'Two GA4 configuration tags with the same measurement ID fire on All Pages — inflates engagement metrics and risks double-counted conversions.', money_monthly_usd: 240, before: { config_tags: 2 }, after: { config_tags: 1 } },
      { id: 'chg-14', account: 'Oasis Fitness', brief_only: false, severity: 'warning', layer: 5, rule_id: 'ads.budget_starved', title: 'Top campaign losing 31% impression share (budget)', explanation: 'Search IS lost to budget = 31% on the converting campaign while a Maximise-clicks campaign underspends. Recommend $15/day reallocation.', money_monthly_usd: 310, before: { 'PT Sessions': '$25/day', 'Generic — Gym': '$40/day' }, after: { 'PT Sessions': '$40/day', 'Generic — Gym': '$25/day' } },
      { id: 'chg-15', account: 'Palm Interiors', brief_only: false, severity: 'warning', layer: 2, rule_id: 'ga4.retention_2m', title: 'GA4 data retention at 2 months', explanation: 'Event-level retention still at the default 2 months; season-over-season analysis impossible. Set to 14 months.', money_monthly_usd: null, before: { retention: '2 months' }, after: { retention: '14 months' } },
      { id: 'chg-16', account: 'Marina Dental', brief_only: false, severity: 'warning', layer: 5, rule_id: 'ads.search_terms_waste', title: '9 zero-conversion search-term themes over 90 days', explanation: '"dental assistant jobs", "dentistry courses", "free consultation" cluster: $610 spend, 0 conversions. 12 negatives proposed at campaign level.', money_monthly_usd: 205, before: { negatives: 14 }, after: { negatives: 26 } },
      { id: 'chg-17', account: 'Glow Studio', brief_only: false, severity: 'warning', layer: 2, rule_id: 'ga4.engagement_as_conversion', title: '"30s engaged session" marked as key event steering bidding', explanation: 'Engagement proxy marked as a key event and imported to Ads as primary. Demote to secondary/observation.', money_monthly_usd: 290, before: { engaged_30s: 'primary' }, after: { engaged_30s: 'secondary' } },
    ],
  },
  'GET /api/agency/review': {
    queue: [
      { id: 'rep-a1', account: 'Glow Studio', type: 'weekly', created_at: '2026-08-17T07:00:00Z' },
      { id: 'rep-a2', account: 'Marina Dental', type: 'weekly', created_at: '2026-08-17T07:02:00Z' },
      { id: 'rep-a4', account: 'Oasis Fitness', type: 'deep', created_at: '2026-08-16T07:00:00Z' },
    ],
  },
  'GET /api/agency/brand': {
    kit: {
      version: 3,
      display_name: 'Northlight Digital',
      logo_light_url: null,
      logo_dark_url: null,
      color_primary: '#0B1F2A',
      color_accent: '#E07A3F',
      footer_text: 'Prepared by Northlight Digital · Performance, measured honestly · northlight.ae',
    },
  },
  'GET /api/agency/seats': {
    seats: [
      { id: 's1', email: 'ana@northlight.ae', name: 'Ana Barros', role: 'admin', status: 'active', created_at: '2026-07-01T09:00:00Z' },
      { id: 's2', email: 'mo@northlight.ae', name: 'Mo Haddad', role: 'am', status: 'active', created_at: '2026-07-01T09:05:00Z' },
      { id: 's3', email: 'rita@northlight.ae', name: 'Rita Kim', role: 'am', status: 'active', created_at: '2026-07-08T10:00:00Z' },
      { id: 's4', email: 'finance@northlight.ae', name: 'Finance', role: 'readonly', status: 'invited', created_at: '2026-08-10T12:00:00Z' },
    ],
  },
  'GET /api/agency/credits': {
    balance: 4,
    events: [
      { delta: 5, reason: 'monthly_grant', created_at: '2026-08-01T00:00:00Z' },
      { delta: -1, reason: 'prospect_audit', created_at: '2026-08-09T14:20:00Z' },
      { delta: -2, reason: 'prospect_audit', created_at: '2026-08-14T11:00:00Z' },
      { delta: 2, reason: 'purchase', created_at: '2026-08-15T09:30:00Z' },
    ],
  },
  'GET /api/agency/accounts': {
    accounts: [
      { id: 'a1', display_name: 'Glow Studio', status: 'active', report_register: 'simple', brief_only: false, seat: { name: 'Mo Haddad' }, created_at: '2026-07-02T09:00:00Z' },
      { id: 'a2', display_name: 'Marina Dental', status: 'active', report_register: 'simple', brief_only: false, seat: { name: 'Mo Haddad' }, created_at: '2026-07-02T09:10:00Z' },
      { id: 'a3', display_name: 'Falcon Movers', status: 'active', report_register: 'technical', brief_only: true, seat: { name: 'Ana Barros' }, created_at: '2026-07-05T11:00:00Z' },
      { id: 'a4', display_name: 'Oasis Fitness', status: 'active', report_register: 'simple', brief_only: false, seat: { name: 'Rita Kim' }, created_at: '2026-07-09T14:00:00Z' },
      { id: 'a5', display_name: 'Palm Interiors', status: 'active', report_register: 'simple', brief_only: false, seat: { name: 'Rita Kim' }, created_at: '2026-07-15T10:00:00Z' },
      { id: 'a6', display_name: 'Desert Rose Spa', status: 'active', report_register: 'simple', brief_only: false, seat: { name: 'Mo Haddad' }, created_at: '2026-07-21T09:00:00Z' },
      { id: 'a7', display_name: 'Bluewater Yachts', status: 'active', report_register: 'technical', brief_only: true, seat: { name: 'Ana Barros' }, created_at: '2026-08-01T09:00:00Z' },
      { id: 'a8', display_name: 'Cedar Kitchen', status: 'active', report_register: 'simple', brief_only: false, seat: { name: 'Rita Kim' }, created_at: '2026-08-04T09:00:00Z' },
      { id: 'a9', display_name: 'Harbor Clinic', status: 'pending', report_register: 'simple', brief_only: false, seat: null, created_at: '2026-08-19T16:00:00Z' },
      { id: 'a10', display_name: 'Old Town Motors', status: 'paused', report_register: 'simple', brief_only: false, seat: { name: 'Ana Barros' }, created_at: '2026-07-03T09:00:00Z' },
    ],
  },
  'GET /api/agency/billing': {
    accounts: 9, rate: 45, band: '1–10', accountsSum: 405, platformFee: 249, total: 654, tier: 'mid',
    cycle: { start: '2026-08-05', end: '2026-09-05', daysInPeriod: 31, daysRemaining: 16 },
    add_today_prorated: 23.23,
  },
  'GET /api/agency/log': {
    entries: [
      { event: 'change_approved', detail: { change_id: 'chg-09' }, created_at: '2026-08-19T08:41:00Z', seat: { name: 'Mo Haddad' } },
      { event: 'report_approved', detail: { report_id: 'rep-93' }, created_at: '2026-08-19T08:12:00Z', seat: { name: 'Ana Barros' } },
      { event: 'change_dismissed', detail: { change_id: 'chg-07', reason: 'client rebuilding page this week' }, created_at: '2026-08-18T16:20:00Z', seat: { name: 'Rita Kim' } },
      { event: 'brand_kit_saved', detail: { version: 3 }, created_at: '2026-08-12T10:02:00Z', seat: { name: 'Ana Barros' } },
      { event: 'seat_invited', detail: { email: 'finance@northlight.ae', role: 'readonly' }, created_at: '2026-08-10T12:00:00Z', seat: { name: 'Ana Barros' } },
    ],
  },
};
