// Canned data for demo mode — every /api/app response, shaped exactly like
// the real dashStore payloads, so screens are reviewable before credentials
// exist. Same fictional business as the sample report (Glow Studio).

import { AGENCY_DEMO } from '../agency/demo.js';

const pending = [
  { id: 'chg-1', title: '$430 a month goes to searches that never book', money_line: 'about $430 a month' },
  { id: 'chg-2', title: 'One campaign is missing 38% of its chances', money_line: 'about $520 a month' },
  { id: 'chg-3', title: 'A 30-second page view is being counted like a booking', money_line: 'about $290 a month' },
];

const ledger = [
  { id: 'l6', event: 'watch_triggered', actor: 'system', summary_text: 'We started a 48-hour watch on your latest fixes.', created_at: '2026-08-18T09:12:00Z' },
  { id: 'l5', event: 'change_applied', actor: 'system', summary_text: 'Applied: 14 searches excluded from your ads. Reversible with one tap.', created_at: '2026-08-18T09:10:00Z' },
  { id: 'l4', event: 'approval', actor: 'user', summary_text: 'You approved 2 fixes from your inbox.', created_at: '2026-08-18T08:57:00Z' },
  { id: 'l3', event: 'report_sent', actor: 'system', summary_text: 'Weekly report delivered — 7 findings, about $1,240 a month at stake.', created_at: '2026-08-17T07:00:00Z' },
  { id: 'l2', event: 'tag_verified', actor: 'system', summary_text: 'Your tracking is live — checked 12 pages, firing correctly.', created_at: '2026-08-12T15:20:00Z' },
  { id: 'l1', event: 'connection_changed', actor: 'user', summary_text: 'Google connected — read access granted.', created_at: '2026-08-12T15:04:00Z' },
];

const reports = [
  { id: 'rep-3', type: 'weekly', created_at: '2026-08-17T07:00:00Z', viewed_at: null },
  { id: 'rep-2', type: 'weekly', created_at: '2026-08-10T07:00:00Z', viewed_at: '2026-08-10T09:14:00Z' },
  { id: 'rep-1', type: 'audit', created_at: '2026-08-05T11:30:00Z', viewed_at: '2026-08-05T11:41:00Z' },
];

const DEMO = {
  'GET /api/app/home': {
    health: {
      score: 58,
      trend: [
        { at: '2026-07-27T07:00:00Z', score: 41 },
        { at: '2026-08-03T07:00:00Z', score: 44 },
        { at: '2026-08-10T07:00:00Z', score: 52 },
        { at: '2026-08-17T07:00:00Z', score: 58 },
      ],
    },
    pending,
    cumulative: { fixes: 6, waste_removed_usd: 730 },
    reports,
    streak: 11,
    plan: { tier: 'core', label: 'Core', band: '4k' },
  },
  'GET /api/app/approvals': { pending },
  'GET /api/app/ledger': { entries: ledger },
  'GET /api/app/reports': { reports },
  'GET /api/app/settings': {
    settings: {
      plan_line: 'Core · $129/mo (active)',
      autopilot: { negatives: false, budgets: false, counting: false },
      connection_status: 'Google connection healthy.',
    },
  },
  'GET /api/app/discovery': {
    matched: [
      { id: 'a1', kind: 'ads_account', external_id: '642-459-1230', display_name: 'Glow Studio — Ads', linked: true },
      { id: 'a2', kind: 'ga4_property', external_id: '3418867', display_name: 'Glow Studio — Analytics', linked: true },
      { id: 'a3', kind: 'gtm_container', external_id: 'GTM-K2P9QX', display_name: 'glowstudio.ae', linked: true },
    ],
    unmatched: [
      { id: 'a4', kind: 'ga4_property', external_id: '2207114', display_name: 'Old site (2023)', linked: false },
    ],
  },
  'GET /api/app/plan': {
    plan: {
      band: '4k',
      tiers: [
        { tier: 'core', label: 'Core', price_usd: 129, selected: true },
        { tier: 'autopilot', label: 'Autopilot', price_usd: 199, selected: false },
        { tier: 'scale', label: 'Scale', price_usd: 399, selected: false },
      ],
    },
  },
  'GET /api/app/first-fix': {
    fix: {
      change_id: 'chg-1',
      finding_title: '$430 a month goes to searches that never book',
      explanation: 'Over 90 days, 11 recurring search themes — nail courses, salon jobs, DIY kits — spent $1,290 and produced zero bookings. Excluding them stops the leak the same day.',
      before_line: 'Your ads show for “nail courses dubai”, “nail technician jobs”, “gel nails at home”…',
      after_line: '14 searches excluded — ads only show to people looking to book.',
    },
  },
  'GET /api/app/journey': {
    journey: {
      journey: 'A',
      stage: 'active',
      gates: { tag: true, approval: true, billing: true },
      instruction_line: 'Everything is set up — your weekly checks run automatically.',
    },
  },
};

export function demoData(path, method) {
  const key = `${method} ${path.split('?')[0]}`;
  if (DEMO[key] !== undefined) return DEMO[key];
  if (AGENCY_DEMO[key] !== undefined) return AGENCY_DEMO[key];
  if (method === 'POST' && path.startsWith('/api/checkout/')) {
    return { url: null, demo: true };
  }
  if (method === 'POST') return { ok: true };
  return undefined;
}
