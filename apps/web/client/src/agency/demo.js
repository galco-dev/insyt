// Agency demo data - a fictional mid-size agency (Northlight Digital, Dubai)
// with 8 managed accounts. Register: full technical vocabulary; this surface
// is exempt from the customer jargon lint (agency reader checks the working).
//
// The demo is STATEFUL: a session-lifetime in-memory store seeded from the
// canned data below. Every write the console can make mutates the store, so
// the demo behaves exactly like a live agency with accounts attached - the
// only difference is that nothing leaves the browser.

const ME = {
  seat: { id: 's1', agency_id: 'ag1', role: 'admin', name: 'Ana Barros', email: 'ana@northlight.ae' },
  agency: { id: 'ag1', name: 'Northlight Digital', platform_tier: 'mid', audit_credits_monthly: 5 },
};

const PORTFOLIO = [
  { id: 'a1', name: 'Glow Studio', manager: 'Mo Haddad', health: 46, open_findings: 9, critical: 3, pending_changes: 4, reports_awaiting_review: 1, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
  { id: 'a2', name: 'Marina Dental', manager: 'Mo Haddad', health: 52, open_findings: 7, critical: 2, pending_changes: 3, reports_awaiting_review: 1, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
  { id: 'a3', name: 'Falcon Movers', manager: 'Ana Barros', health: 61, open_findings: 5, critical: 1, pending_changes: 2, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: true, register: 'technical' },
  { id: 'a4', name: 'Oasis Fitness', manager: 'Rita Kim', health: 66, open_findings: 4, critical: 1, pending_changes: 1, reports_awaiting_review: 1, last_report_at: '2026-08-16T07:00:00Z', brief_only: false, register: 'simple' },
  { id: 'a5', name: 'Palm Interiors', manager: 'Rita Kim', health: 74, open_findings: 3, critical: 0, pending_changes: 2, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
  { id: 'a6', name: 'Desert Rose Spa', manager: 'Mo Haddad', health: 78, open_findings: 2, critical: 0, pending_changes: 0, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
  { id: 'a7', name: 'Bluewater Yachts', manager: 'Ana Barros', health: 83, open_findings: 2, critical: 0, pending_changes: 0, reports_awaiting_review: 0, last_report_at: '2026-08-15T07:00:00Z', brief_only: true, register: 'technical' },
  { id: 'a8', name: 'Cedar Kitchen', manager: 'Rita Kim', health: 88, open_findings: 1, critical: 0, pending_changes: 0, reports_awaiting_review: 0, last_report_at: '2026-08-17T07:00:00Z', brief_only: false, register: 'simple' },
];

const TRIAGE = [
  { id: 'chg-11', account: 'Glow Studio', brief_only: false, severity: 'critical', layer: 4, rule_id: 'ads.dual_primary', title: 'Dual primary conversion actions double-counting purchases', explanation: 'GA4 key event "booking_confirmed" and the website tag "book_now_click" are both primary. Smart bidding optimises to ~2× true conversions.', money_monthly_usd: 430, before: { primary: ['booking_confirmed', 'book_now_click'] }, after: { primary: ['booking_confirmed'], secondary: ['book_now_click'] } },
  { id: 'chg-12', account: 'Marina Dental', brief_only: false, severity: 'critical', layer: 3, rule_id: 'ga4.event_never_fired', title: 'Key event configured in GTM but never observed in GA4 (14 days)', explanation: 'Tag "appointment_booked" exists in the container, zero events in the GA4 stream since the 4 Aug container publish. Trigger references a CSS selector removed from the booking page.', money_monthly_usd: 390, before: { trigger: '.btn-book-v1 click' }, after: { trigger: '.booking-submit click (verified present)' } },
  { id: 'chg-13', account: 'Falcon Movers', brief_only: true, severity: 'warning', layer: 1, rule_id: 'gtm.duplicate_ga4_config', title: 'Duplicate GA4 config tags firing on all pages', explanation: 'Two GA4 configuration tags with the same measurement ID fire on All Pages - inflates engagement metrics and risks double-counted conversions.', money_monthly_usd: 240, before: { config_tags: 2 }, after: { config_tags: 1 } },
  { id: 'chg-14', account: 'Oasis Fitness', brief_only: false, severity: 'warning', layer: 5, rule_id: 'ads.budget_starved', campaign_ref: '20981001', campaign_name: 'PT Sessions', title: 'Top campaign losing 31% impression share (budget)', explanation: 'Search IS lost to budget = 31% on the converting campaign while a Maximise-clicks campaign underspends. Recommend $15/day reallocation.', money_monthly_usd: 310, before: { 'PT Sessions': '$25/day', 'Generic - Gym': '$40/day' }, after: { 'PT Sessions': '$40/day', 'Generic - Gym': '$25/day' } },
  { id: 'chg-18', account: 'Glow Studio', brief_only: false, severity: 'warning', layer: 5, rule_id: 'ads.wrong_bidding_goal', campaign_ref: '21436590', campaign_name: 'Generic - Nails', title: 'Campaign optimising to Maximise clicks with conversion data available', explanation: '9 conversions in 30 days on this campaign, but bidding still targets clicks. Switch to Maximise conversions; expected CPA improvement from account history ~22%.', money_monthly_usd: 260, before: { bidding: 'Maximise clicks' }, after: { bidding: 'Maximise conversions' } },
  { id: 'chg-15', account: 'Palm Interiors', brief_only: false, severity: 'warning', layer: 2, rule_id: 'ga4.retention_2m', title: 'GA4 data retention at 2 months', explanation: 'Event-level retention still at the default 2 months; season-over-season analysis impossible. Set to 14 months.', money_monthly_usd: null, before: { retention: '2 months' }, after: { retention: '14 months' }, snoozed_until: '2026-08-27T09:00:00Z', snooze_reason: 'client rebuilding GA4 property next week' },
  { id: 'chg-16', account: 'Marina Dental', brief_only: false, severity: 'warning', layer: 5, rule_id: 'ads.search_terms_waste', campaign_ref: '20873321', campaign_name: 'Smile Bright - Search', title: '9 zero-conversion search-term themes over 90 days', explanation: '"dental assistant jobs", "dentistry courses", "free consultation" cluster: $610 spend, 0 conversions. 12 negatives proposed at campaign level.', money_monthly_usd: 205, before: { negatives: 14 }, after: { negatives: 26 } },
  { id: 'chg-17', account: 'Glow Studio', brief_only: false, severity: 'warning', layer: 2, rule_id: 'ga4.engagement_as_conversion', title: '"30s engaged session" marked as key event steering bidding', explanation: 'Engagement proxy marked as a key event and imported to Ads as primary. Demote to secondary/observation.', money_monthly_usd: 290, before: { engaged_30s: 'primary' }, after: { engaged_30s: 'secondary' } },
  { id: 'chg-19', account: 'Cedar Kitchen', brief_only: false, severity: 'info', layer: 4, rule_id: 'ads.missing_brand_campaign', build_template: 'brand', title: 'No brand campaign - competitors own "cedar kitchen" searches', explanation: 'Searches for the business name go to competitors bidding on it; brand clicks are the cheapest in the account. A build draft is one click away - created paused, enabled only when you say so.', money_monthly_usd: 95, before: { brand_campaigns: 0 }, after: { brand_campaigns: 1, state: 'paused until enabled' } },
  { id: 'chg-20', account: 'Marina Dental', brief_only: false, severity: 'critical', layer: 5, rule_id: 'url.broken', campaign_ref: '20873322', campaign_name: 'Invisalign - PMax', title: '2 ads send paid clicks to a 404', explanation: '/invisalign-offer was removed in last week\'s site update; ads still point at it. HTTP 404 on every click - pause the ads or fix the URL today.', money_monthly_usd: 380, before: { final_url: '/invisalign-offer (404)' }, after: { final_url: '/invisalign (200 verified)' } },
  { id: 'chg-21', account: 'Oasis Fitness', brief_only: false, severity: 'warning', layer: 4, rule_id: 'rsa.thin_assets', campaign_ref: '20981001', campaign_name: 'PT Sessions', title: 'RSA running 5 headlines / 2 descriptions (recommended 8+/3+)', explanation: 'Fewer assets = fewer combinations Google can test = weaker serving. Replacement assets drafted from the ad group\'s converting keywords.', money_monthly_usd: 120, before: { headlines: 5, descriptions: 2, strength: 'AVERAGE' }, after: { headlines: 10, descriptions: 4 } },
];

const DRAFTS = [
  { id: 'd-1', account_id: 'a8', account: 'Cedar Kitchen', template: 'brand', status: 'draft', created_at: '2026-08-20T11:05:00Z', created_by_name: 'Rita Kim', spec: { name: 'Brand - Cedar Kitchen', channel: 'search', budget_daily_usd: 8, bidding: 'Maximise conversions', conversion_goal: 'catering_enquiry', settings: { geo: 'Dubai', networks: ['search'], start_paused: true }, ad_groups: [{ name: 'Brand', keywords: [{ text: '"cedar kitchen"', match: 'phrase' }, { text: '[cedar kitchen]', match: 'exact' }], negatives: ['jobs', 'careers', 'salary'], rsa: { headlines: ['Cedar Kitchen - Official Site', 'Cedar Kitchen', 'Book Today', 'Trusted Local Choice', 'See Prices & Availability', 'Rated by Real Customers', 'Fast Response', 'Get In Touch Now'], descriptions: ['Cedar Kitchen - the official site. See services, prices and availability, and book in minutes.', 'Real reviews, clear prices, quick booking.', 'Questions? Reach us directly - we reply fast.', 'Book online in under a minute.'], pinned: { headline_1: 'Cedar Kitchen - Official Site' } } }], tracking_checks: ['conversion goal exists and fired in the last 14 days', 'no duplicate primary conversion actions', 'final URLs resolve 200 on the live site'] } },
  { id: 'd-2', account_id: 'a1', account: 'Glow Studio', template: 'remarketing', status: 'created_paused', google_campaign_id: 'draft-glo-rmk1', created_at: '2026-08-19T15:40:00Z', created_by_name: 'Mo Haddad', spec: { name: 'Remarketing - Glow Studio', channel: 'display', budget_daily_usd: 10, bidding: 'Maximise conversions', conversion_goal: 'booking_confirmed', settings: { geo: 'Dubai', networks: ['display'], start_paused: true }, ad_groups: [{ name: 'Site visitors 30d', audience: 'site_visitors_30d', keywords: [], negatives: [], rsa: { headlines: ['Still thinking it over?', 'Glow Studio', 'Come back and book', 'Prices & availability'], descriptions: ['You looked at Glow Studio recently - booking takes under a minute.', 'Real reviews, clear prices. Pick a time that suits you.'], pinned: {} } }], tracking_checks: ['conversion goal exists and fired in the last 14 days'] } },
];

const CAMPAIGNS = [
  { account_id: 'a1', account: 'Glow Studio', google_campaign_id: '21436587', name: 'Gel & Extensions', status: 'enabled', channel: 'search', budget_daily_usd: 40, bidding: 'Maximise conversions' },
  { account_id: 'a1', account: 'Glow Studio', google_campaign_id: '21436588', name: 'Brand - Glow Studio', status: 'enabled', channel: 'search', budget_daily_usd: 12, bidding: 'Maximise conversions' },
  { account_id: 'a1', account: 'Glow Studio', google_campaign_id: '21436589', name: 'Lashes', status: 'enabled', channel: 'search', budget_daily_usd: 25, bidding: 'Maximise conversions' },
  { account_id: 'a1', account: 'Glow Studio', google_campaign_id: '21436590', name: 'Generic - Nails', status: 'enabled', channel: 'search', budget_daily_usd: 52, bidding: 'Maximise clicks' },
  { account_id: 'a2', account: 'Marina Dental', google_campaign_id: '20873321', name: 'Smile Bright - Search', status: 'enabled', channel: 'search', budget_daily_usd: 60, bidding: 'tCPA $45' },
  { account_id: 'a2', account: 'Marina Dental', google_campaign_id: '20873322', name: 'Invisalign - PMax', status: 'enabled', channel: 'pmax', budget_daily_usd: 35, bidding: 'Maximise conversions' },
  { account_id: 'a2', account: 'Marina Dental', google_campaign_id: '20873323', name: 'Brand - Marina', status: 'enabled', channel: 'search', budget_daily_usd: 10, bidding: 'Maximise clicks' },
  { account_id: 'a3', account: 'Falcon Movers', google_campaign_id: '19442210', name: 'Moves - Dubai', status: 'enabled', channel: 'search', budget_daily_usd: 45, bidding: 'tCPA $60' },
  { account_id: 'a3', account: 'Falcon Movers', google_campaign_id: '19442211', name: 'Storage', status: 'paused', channel: 'search', budget_daily_usd: 15, bidding: 'Maximise clicks' },
  { account_id: 'a4', account: 'Oasis Fitness', google_campaign_id: '20981001', name: 'PT Sessions', status: 'enabled', channel: 'search', budget_daily_usd: 25, bidding: 'Maximise conversions' },
  { account_id: 'a4', account: 'Oasis Fitness', google_campaign_id: '20981002', name: 'Generic - Gym', status: 'enabled', channel: 'search', budget_daily_usd: 40, bidding: 'Maximise clicks' },
  { account_id: 'a4', account: 'Oasis Fitness', google_campaign_id: '20981003', name: 'Classes - PMax', status: 'enabled', channel: 'pmax', budget_daily_usd: 20, bidding: 'Maximise conversions' },
  { account_id: 'a5', account: 'Palm Interiors', google_campaign_id: '22010440', name: 'Fit-outs - Search', status: 'enabled', channel: 'search', budget_daily_usd: 55, bidding: 'tROAS 320%' },
  { account_id: 'a5', account: 'Palm Interiors', google_campaign_id: '22010441', name: 'Brand - Palm', status: 'enabled', channel: 'search', budget_daily_usd: 8, bidding: 'Maximise clicks' },
  { account_id: 'a6', account: 'Desert Rose Spa', google_campaign_id: '21777801', name: 'Massage - Search', status: 'enabled', channel: 'search', budget_daily_usd: 30, bidding: 'Maximise conversions' },
  { account_id: 'a7', account: 'Bluewater Yachts', google_campaign_id: '18665430', name: 'Charters - Search', status: 'enabled', channel: 'search', budget_daily_usd: 90, bidding: 'tCPA $140' },
  { account_id: 'a8', account: 'Cedar Kitchen', google_campaign_id: '22344120', name: 'Catering - Search', status: 'enabled', channel: 'search', budget_daily_usd: 22, bidding: 'Maximise conversions' },
];

const PACING = [
  { account_id: 'a1', account: 'Glow Studio', targets: { monthly_budget_usd: 3900, cpa_target_usd: 45, roas_target: null }, pacing: { budget: 3900, mtd: 2960, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 2516.13, projected: 4588, deltaPct: 17.6, status: 'over' }, performance: { cpa: 51.3, roas: null, cpaTargetUsd: 45, roasTarget: null, status: 'missing' } },
  { account_id: 'a4', account: 'Oasis Fitness', targets: { monthly_budget_usd: 2600, cpa_target_usd: 38, roas_target: null }, pacing: { budget: 2600, mtd: 1690, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 1677.42, projected: 2620, deltaPct: 0.8, status: 'at_risk' }, performance: { cpa: 35.1, roas: null, cpaTargetUsd: 38, roasTarget: null, status: 'hitting' } },
  { account_id: 'a2', account: 'Marina Dental', targets: { monthly_budget_usd: 3200, cpa_target_usd: 45, roas_target: null }, pacing: { budget: 3200, mtd: 1495, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 2064.52, projected: 2317, deltaPct: -27.6, status: 'under' }, performance: { cpa: 42.8, roas: null, cpaTargetUsd: 45, roasTarget: null, status: 'hitting' } },
  { account_id: 'a3', account: 'Falcon Movers', targets: { monthly_budget_usd: null, cpa_target_usd: 60, roas_target: null }, pacing: { budget: null, mtd: 1180, dayOfMonth: 20, daysInMonth: 31, expectedToDate: null, projected: null, deltaPct: null, status: 'no_budget' }, performance: { cpa: 66.2, roas: null, cpaTargetUsd: 60, roasTarget: null, status: 'missing' } },
  { account_id: 'a5', account: 'Palm Interiors', targets: { monthly_budget_usd: 1900, cpa_target_usd: null, roas_target: 3.2 }, pacing: { budget: 1900, mtd: 1230, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 1225.81, projected: 1907, deltaPct: 0.4, status: 'on_pace' }, performance: { cpa: null, roas: 3.44, cpaTargetUsd: null, roasTarget: 3.2, status: 'hitting' } },
  { account_id: 'a7', account: 'Bluewater Yachts', targets: { monthly_budget_usd: 2700, cpa_target_usd: 140, roas_target: null }, pacing: { budget: 2700, mtd: 1760, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 1741.94, projected: 2728, deltaPct: 1.0, status: 'on_pace' }, performance: { cpa: 131, roas: null, cpaTargetUsd: 140, roasTarget: null, status: 'hitting' } },
  { account_id: 'a6', account: 'Desert Rose Spa', targets: { monthly_budget_usd: 900, cpa_target_usd: null, roas_target: null }, pacing: { budget: 900, mtd: 585, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 580.65, projected: 907, deltaPct: 0.8, status: 'on_pace' }, performance: { cpa: 28.4, roas: null, cpaTargetUsd: null, roasTarget: null, status: 'no_target' } },
  { account_id: 'a8', account: 'Cedar Kitchen', targets: { monthly_budget_usd: 660, cpa_target_usd: 25, roas_target: null }, pacing: { budget: 660, mtd: 428, dayOfMonth: 20, daysInMonth: 31, expectedToDate: 425.81, projected: 663, deltaPct: 0.5, status: 'on_pace' }, performance: { cpa: 23.9, roas: null, cpaTargetUsd: 25, roasTarget: null, status: 'hitting' } },
];

const ALERTS = [
  { id: 'al-1', account: 'Glow Studio', severity: 'critical', kind: 'spend_spike', title: 'Generic - Nails spending 2.4× its daily average', detail: { note: '$126 by 14:00 vs $52 typical. Started after yesterday’s bid change. Auction-price movement on "nail extensions dubai".' }, campaign_ref: '21436590', created_at: '2026-08-20T10:12:00Z', acked_at: null },
  { id: 'al-2', account: 'Marina Dental', severity: 'critical', kind: 'tag_down', title: 'GA4 purchase events stopped firing', detail: { note: 'Zero booking_confirmed events since 14:00 yesterday; sessions normal. Smart bidding is now flying blind on this account.' }, campaign_ref: null, created_at: '2026-08-20T07:40:00Z', acked_at: null },
  { id: 'al-3', account: 'Oasis Fitness', severity: 'warning', kind: 'disapproval', title: '3 assets disapproved in Classes - PMax', detail: { note: 'Policy: unsupported health claims. Serving reduced until replaced.' }, campaign_ref: '20981003', created_at: '2026-08-20T06:15:00Z', acked_at: null },
  { id: 'al-4', account: 'Glow Studio', severity: 'warning', kind: 'pace_over', title: 'Projected 18% over August budget', detail: { note: '$4,588 projected vs $3,900 target at current run rate.' }, campaign_ref: null, created_at: '2026-08-19T20:00:00Z', acked_at: null },
  { id: 'al-5', account: 'Falcon Movers', severity: 'info', kind: 'conv_flatline', title: 'Zero conversions in 5 days', detail: { note: 'Typical 1.8/day. Lead form on /quote returns 500 intermittently - likely the cause, not the ads.' }, campaign_ref: '19442210', created_at: '2026-08-19T09:30:00Z', acked_at: '2026-08-19T10:02:00Z', acked_seat: { name: 'Ana Barros' } },
  { id: 'al-6', account: 'Oasis Fitness', severity: 'info', kind: 'budget_limited', title: 'PT Sessions lost 31% impression share to budget yesterday', detail: { note: 'Matching triage item proposes a $15/day reallocation from Generic - Gym.' }, campaign_ref: '20981001', created_at: '2026-08-19T08:00:00Z', acked_at: null },
];

const REVIEW = [
  { id: 'rep-a1', account: 'Glow Studio', type: 'weekly', created_at: '2026-08-17T07:00:00Z' },
  { id: 'rep-a2', account: 'Marina Dental', type: 'weekly', created_at: '2026-08-17T07:02:00Z' },
  { id: 'rep-a4', account: 'Oasis Fitness', type: 'deep', created_at: '2026-08-16T07:00:00Z' },
];

const BRAND = {
  version: 3,
  display_name: 'Northlight Digital',
  logo_light_url: null,
  logo_dark_url: null,
  color_primary: '#0B1F2A',
  color_accent: '#E07A3F',
  footer_text: 'Prepared by Northlight Digital · Performance, measured honestly · northlight.ae',
};

const SEATS = [
  { id: 's1', email: 'ana@northlight.ae', name: 'Ana Barros', role: 'admin', status: 'active', created_at: '2026-07-01T09:00:00Z' },
  { id: 's2', email: 'mo@northlight.ae', name: 'Mo Haddad', role: 'am', status: 'active', created_at: '2026-07-01T09:05:00Z' },
  { id: 's3', email: 'rita@northlight.ae', name: 'Rita Kim', role: 'am', status: 'active', created_at: '2026-07-08T10:00:00Z' },
  { id: 's4', email: 'finance@northlight.ae', name: 'Finance', role: 'readonly', status: 'invited', created_at: '2026-08-10T12:00:00Z' },
];

const CREDITS = {
  balance: 4,
  events: [
    { delta: 5, reason: 'monthly_grant', created_at: '2026-08-01T00:00:00Z' },
    { delta: -1, reason: 'prospect_audit', created_at: '2026-08-09T14:20:00Z' },
    { delta: -2, reason: 'prospect_audit', created_at: '2026-08-14T11:00:00Z' },
    { delta: 2, reason: 'purchase', created_at: '2026-08-15T09:30:00Z' },
  ],
};

const ACCOUNTS = [
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
];

const LOG = [
  { event: 'change_approved', detail: { change_id: 'chg-09' }, created_at: '2026-08-19T08:41:00Z', seat: { name: 'Mo Haddad' } },
  { event: 'report_approved', detail: { report_id: 'rep-93' }, created_at: '2026-08-19T08:12:00Z', seat: { name: 'Ana Barros' } },
  { event: 'change_dismissed', detail: { change_id: 'chg-07', reason: 'client rebuilding page this week' }, created_at: '2026-08-18T16:20:00Z', seat: { name: 'Rita Kim' } },
  { event: 'brand_kit_saved', detail: { version: 3 }, created_at: '2026-08-12T10:02:00Z', seat: { name: 'Ana Barros' } },
  { event: 'seat_invited', detail: { email: 'finance@northlight.ae', role: 'readonly' }, created_at: '2026-08-10T12:00:00Z', seat: { name: 'Ana Barros' } },
];

// ---------------------------------------------------------------- store

let S = null;
function state() {
  if (!S) {
    S = structuredClone({
      me: ME, portfolio: PORTFOLIO, triage: TRIAGE, drafts: DRAFTS, campaigns: CAMPAIGNS,
      pacing: PACING, alerts: ALERTS, review: REVIEW, brand: BRAND, seats: SEATS,
      credits: CREDITS, accounts: ACCOUNTS, log: LOG, draftSeq: 3, accountSeq: 11, campaignSeq: 90000001,
    });
  }
  return S;
}

const now = () => new Date().toISOString();
const log = (s, event, detail) => { s.log.unshift({ event, detail: detail || {}, created_at: now(), seat: { name: s.me.seat.name } }); };
const account = (s, name) => s.portfolio.find((a) => a.name === name);

function portfolioView(s) {
  return s.portfolio.map((a) => ({
    ...a,
    pending_changes: s.triage.filter((t) => t.account === a.name).length,
    reports_awaiting_review: s.review.filter((r) => r.account === a.name).length,
  }));
}

function billingView(s) {
  const count = s.accounts.filter((a) => a.status === 'active' || a.status === 'pending').length;
  const rate = count > 30 ? 35 : 45;
  const band = count <= 10 ? '1–10' : count <= 30 ? '11–30' : '31+';
  return {
    accounts: count, rate, band, accountsSum: rate * count, platformFee: 249, total: 249 + rate * count, tier: 'mid',
    cycle: { start: '2026-08-05', end: '2026-09-05', daysInPeriod: 31, daysRemaining: 16 },
    add_today_prorated: Math.round((rate * (16 / 31)) * 100) / 100,
  };
}

function repace(row) {
  const { dayOfMonth, daysInMonth, mtd } = row.pacing;
  const budget = row.targets.monthly_budget_usd;
  if (!budget) {
    row.pacing = { ...row.pacing, budget: null, expectedToDate: null, projected: null, deltaPct: null, status: 'no_budget' };
  } else {
    const expected = Math.round((budget * (dayOfMonth / daysInMonth)) * 100) / 100;
    const projected = Math.round(mtd * (daysInMonth / dayOfMonth));
    const deltaPct = Math.round(((projected - budget) / budget) * 1000) / 10;
    const status = deltaPct > 8 ? 'over' : deltaPct < -8 ? 'under' : Math.abs(deltaPct) > 3 ? 'at_risk' : 'on_pace';
    row.pacing = { ...row.pacing, budget, expectedToDate: expected, projected, deltaPct, status };
  }
  const p = row.performance;
  p.cpaTargetUsd = row.targets.cpa_target_usd;
  p.roasTarget = row.targets.roas_target;
  if (p.cpaTargetUsd == null && p.roasTarget == null) p.status = 'no_target';
  else if ((p.cpaTargetUsd != null && p.cpa != null && p.cpa <= p.cpaTargetUsd) || (p.roasTarget != null && p.roas != null && p.roas >= p.roasTarget)) p.status = 'hitting';
  else p.status = 'missing';
}

function approveOne(s, id) {
  const i = s.triage.findIndex((t) => t.id === id);
  if (i === -1) return;
  const item = s.triage[i];
  s.triage.splice(i, 1);
  const acc = account(s, item.account);
  if (acc) {
    acc.open_findings = Math.max(0, acc.open_findings - 1);
    if (item.severity === 'critical') acc.critical = Math.max(0, acc.critical - 1);
    acc.health = Math.min(96, acc.health + (item.severity === 'critical' ? 4 : 2));
  }
  log(s, 'change_approved', { change_id: id, account: item.account, title: item.title });
}

function buildSpec(s, accountName, template, inputs) {
  const services = (inputs && inputs.services && inputs.services.length ? inputs.services : ['core service']);
  const geo = (inputs && inputs.location) || 'Dubai';
  const budget = (inputs && inputs.budget_daily_usd) || (template === 'brand' ? 8 : 15);
  const base = {
    brand: { name: `Brand - ${accountName}`, channel: 'search' },
    remarketing: { name: `Remarketing - ${accountName}`, channel: 'display' },
    search: { name: `${services[0]} - Search`, channel: 'search' },
  }[template] || { name: `${accountName} - Search`, channel: 'search' };
  const kw = template === 'brand'
    ? [{ text: `"${accountName.toLowerCase()}"`, match: 'phrase' }, { text: `[${accountName.toLowerCase()}]`, match: 'exact' }]
    : services.map((sv) => ({ text: `"${sv.toLowerCase()} ${geo.toLowerCase()}"`, match: 'phrase' }));
  return {
    name: base.name,
    channel: base.channel,
    budget_daily_usd: budget,
    bidding: 'Maximise conversions',
    conversion_goal: 'primary enquiry',
    settings: { geo, networks: [base.channel], start_paused: true },
    ad_groups: [{
      name: template === 'brand' ? 'Brand' : services[0],
      keywords: kw,
      negatives: ['jobs', 'careers', 'salary', 'free'],
      rsa: {
        headlines: [`${accountName} - Official Site`, accountName, 'Book Today', 'See Prices & Availability', 'Trusted Local Choice', 'Fast Response', 'Rated by Real Customers', 'Get In Touch Now'],
        descriptions: [`${accountName} - the official site. See services, prices and availability, and book in minutes.`, 'Real reviews, clear prices, quick booking.', 'Questions? Reach us directly - we reply fast.'],
        pinned: { headline_1: `${accountName} - Official Site` },
      },
    }],
    tracking_checks: ['conversion goal exists and fired in the last 14 days', 'no duplicate primary conversion actions', 'final URLs resolve 200 on the live site'],
  };
}

// ---------------------------------------------------------------- handler

export function agencyDemo(path, method, body) {
  const s = state();
  const p = path.split('?')[0].slice('/api/agency'.length) || '/';

  if (method === 'GET') {
    if (p === '/me') return { seat: s.me.seat, agency: s.me.agency };
    if (p === '/portfolio') return { accounts: portfolioView(s) };
    if (p === '/triage') return { queue: s.triage };
    if (p === '/drafts') return { drafts: s.drafts };
    if (p === '/campaigns') return { campaigns: s.campaigns };
    if (p === '/pacing') return { accounts: s.pacing };
    if (p === '/alerts') return { alerts: s.alerts };
    if (p === '/review') return { queue: s.review };
    if (p === '/brand') return { kit: s.brand };
    if (p === '/seats') return { seats: s.seats };
    if (p === '/credits') return { balance: s.credits.balance, events: s.credits.events };
    if (p === '/accounts') return { accounts: s.accounts };
    if (p === '/billing') return billingView(s);
    if (p === '/log') return { entries: s.log };
    return undefined;
  }

  if (method !== 'POST') return undefined;

  if (p.startsWith('/approve/')) { approveOne(s, p.split('/')[2]); return { ok: true }; }
  if (p.startsWith('/dismiss/')) {
    const id = p.split('/')[2];
    const i = s.triage.findIndex((t) => t.id === id);
    if (i !== -1) {
      const item = s.triage.splice(i, 1)[0];
      const acc = account(s, item.account);
      if (acc) acc.open_findings = Math.max(0, acc.open_findings - 1);
      log(s, 'change_dismissed', { change_id: id, reason: (body && body.reason) || null });
    }
    return { ok: true };
  }
  if (p.startsWith('/snooze/')) {
    const id = p.split('/')[2];
    const item = s.triage.find((t) => t.id === id);
    const days = (body && body.days) || 7;
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    if (item) { item.snoozed_until = until; item.snooze_reason = (body && body.reason) || null; }
    log(s, 'change_snoozed', { change_id: id, days });
    return { ok: true, until };
  }
  if (p === '/approve-batch') {
    ((body && body.ids) || []).forEach((id) => approveOne(s, id));
    return { ok: true };
  }
  if (p.startsWith('/targets/')) {
    const accountId = p.split('/')[2];
    const row = s.pacing.find((r) => r.account_id === accountId);
    if (row) {
      row.targets = {
        monthly_budget_usd: body ? body.monthly_budget_usd : row.targets.monthly_budget_usd,
        cpa_target_usd: body ? body.cpa_target_usd : row.targets.cpa_target_usd,
        roas_target: body ? body.roas_target : row.targets.roas_target,
      };
      repace(row);
      log(s, 'targets_updated', { account_id: accountId });
    }
    return { ok: true };
  }
  if (p.startsWith('/alerts/') && p.endsWith('/ack')) {
    const id = p.split('/')[2];
    const a = s.alerts.find((x) => x.id === id);
    if (a) { a.acked_at = now(); a.acked_seat = { name: s.me.seat.name }; }
    return { ok: true };
  }
  if (p === '/drafts') {
    const accountRow = s.accounts.find((a) => a.id === (body && body.account_id));
    const name = accountRow ? accountRow.display_name : 'New account';
    const template = (body && body.template) || 'search';
    const draft = {
      id: `d-${s.draftSeq++}`,
      account_id: body && body.account_id,
      account: name,
      template,
      status: 'draft',
      created_at: now(),
      created_by_name: s.me.seat.name,
      spec: buildSpec(s, name, template, body && body.inputs),
    };
    s.drafts.unshift(draft);
    log(s, 'draft_created', { draft_id: draft.id, account: name, template });
    return { ok: true, draft };
  }
  if (p.startsWith('/drafts/')) {
    const [, , id, action] = p.split('/');
    const d = s.drafts.find((x) => x.id === id);
    if (!d) return { ok: true, status: 'dismissed' };
    if (action === 'approve' || action === 'apply') {
      d.status = 'created_paused';
      d.google_campaign_id = `demo-${s.campaignSeq++}`;
      s.campaigns.unshift({ account_id: d.account_id, account: d.account, google_campaign_id: d.google_campaign_id, name: d.spec.name, status: 'paused', channel: d.spec.channel, budget_daily_usd: d.spec.budget_daily_usd, bidding: d.spec.bidding });
      log(s, 'campaign_created_paused', { draft_id: d.id, account: d.account });
    } else if (action === 'enable') {
      d.status = 'enabled';
      const c = s.campaigns.find((x) => x.google_campaign_id === d.google_campaign_id);
      if (c) c.status = 'enabled';
      log(s, 'campaign_enabled', { draft_id: d.id, account: d.account });
    } else {
      d.status = 'dismissed';
      log(s, 'draft_dismissed', { draft_id: d.id });
    }
    return { ok: true, status: d.status };
  }
  if (p.startsWith('/report/')) {
    const [, , id, kind] = p.split('/');
    const i = s.review.findIndex((r) => r.id === id);
    if (i !== -1) {
      const rep = s.review.splice(i, 1)[0];
      log(s, kind === 'approve' ? 'report_approved' : 'report_rejected', { report_id: id, account: rep.account, reason: body && body.reason });
    }
    return { ok: true };
  }
  if (p === '/accounts') {
    const acct = {
      id: `a${s.accountSeq++}`,
      display_name: (body && body.display_name) || 'New account',
      status: 'pending',
      report_register: 'simple',
      brief_only: false,
      seat: null,
      created_at: now(),
    };
    s.accounts.push(acct);
    log(s, 'account_added', { account: acct.display_name });
    return { ok: true, account: acct };
  }
  if (p.startsWith('/accounts/')) {
    const [, , id, kind] = p.split('/');
    const i = s.accounts.findIndex((a) => a.id === id);
    if (i !== -1) {
      if (kind === 'remove') { log(s, 'account_removed', { account: s.accounts[i].display_name }); s.accounts.splice(i, 1); }
      else { s.accounts[i].status = kind === 'pause' ? 'paused' : 'active'; log(s, kind === 'pause' ? 'account_paused' : 'account_resumed', { account: s.accounts[i].display_name }); }
    }
    return { ok: true };
  }
  if (p === '/brand') {
    s.brand = { ...s.brand, ...(body || {}), version: (s.brand.version || 0) + 1 };
    log(s, 'brand_kit_saved', { version: s.brand.version });
    return { ok: true, version: s.brand.version, kit: s.brand };
  }
  return { ok: true };
}
