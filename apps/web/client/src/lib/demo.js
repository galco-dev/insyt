// Canned data for demo mode - every /api/app response, shaped exactly like
// the real dashStore payloads, so screens are reviewable before credentials
// exist. Same fictional business as the sample report (Glow Studio).

import { agencyDemo } from '../agency/demo.js';
import { audit as sampleAudit } from '../report/data.js';

const pending = [
  {
    id: 'chg-1',
    category: 'negatives',
    title: '$430 a month goes to searches that never book',
    money_line: 'stopped the same day you approve',
    explanation: 'Over 90 days, 11 recurring search themes - nail courses, salon jobs, DIY kits - spent money and produced zero bookings.',
    before_line: 'Your ads show for "nail courses dubai", "nail technician jobs", "gel nails at home"',
    after_line: '14 searches excluded - your ads only show to people looking to book',
  },
  {
    id: 'chg-2',
    title: 'One campaign is missing 38% of its chances',
    money_line: 'about $520 a month left on the table',
    explanation: 'Your strongest campaign runs out of budget by mid-afternoon most days, while a weaker one never spends its full budget.',
    before_line: 'Budgets split $40 / $25 a day - the strongest campaign is capped daily',
    after_line: 'Budgets split $52 / $13 a day - the strongest campaign never gets capped',
  },
  {
    id: 'chg-3',
    category: 'counting',
    title: 'A 30-second page view is being counted like a booking',
    money_line: 'about $290 a month spent on flattered keywords',
    explanation: 'A quick page view is currently recorded as if it were a booking, which makes weak keywords look like winners.',
    before_line: 'Page views counted alongside real bookings',
    after_line: 'Only real enquiry forms and calls counted as bookings',
  },
  // Creation-as-finding: a new ad arrives through the same approve flow as
  // every fix. It is created switched off; turning it on is a second yes.
  {
    id: 'chg-4',
    title: 'People searching “Glow Studio” see competitors - your own-name ad is drafted and ready',
    money_line: 'about $8 a day, and it starts switched off',
    explanation: 'Competitors show above you when people search your own name. A simple own-name ad puts you back on top.',
    before_line: 'Searches for "Glow Studio" show competitor ads first',
    after_line: 'Your own ad on top - created switched off, turning it on is a second yes',
  },
];

// The latest fix lands a few days ago so the month line and the receipt read
// as current whenever the sample is opened.
const daysAgo = (n, h = 9) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); d.setUTCHours(h, 10, 0, 0); return d.toISOString(); };
const RECEIPTS = {
  'chg-0': { change_id: 'chg-0', finding_id: null, applied_at: daysAgo(3), state: 'verified', verified_at: daysAgo(1), line: 'Wasted-term clicks down 92% over 48 hours', watch_until: null },
};
const ledger = [
  { id: 'l6', event: 'watch_triggered', actor: 'system', summary_text: 'We started a 48-hour watch on your latest fixes.', created_at: daysAgo(3, 9) },
  { id: 'l5', event: 'fix_applied', actor: 'system', change_id: 'chg-0', money_impact_usd: 430, summary_text: 'Excluded 14 searches from your ads. Reversible with one tap.', created_at: daysAgo(3, 9) },
  { id: 'l4', event: 'approval', actor: 'user', summary_text: 'You approved 2 fixes from your inbox.', created_at: daysAgo(3, 8) },
  { id: 'l3', event: 'report_sent', actor: 'system', summary_text: 'Weekly report delivered - 7 findings, about $1,240 a month at stake.', created_at: '2026-08-17T07:00:00Z' },
  { id: 'l2', event: 'tag_verified', actor: 'system', summary_text: 'Your tracking is live - checked 12 pages, firing correctly.', created_at: '2026-08-12T15:20:00Z' },
  { id: 'l1', event: 'connection_changed', actor: 'user', summary_text: 'Google connected - read access granted.', created_at: '2026-08-12T15:04:00Z' },
];

const reports = [
  { id: 'rep-3', type: 'weekly', created_at: '2026-08-17T07:00:00Z', viewed_at: null, summary: { health_score: 58, waste_monthly_usd: 1240 } },
  { id: 'rep-2', type: 'weekly', created_at: '2026-08-10T07:00:00Z', viewed_at: '2026-08-10T09:14:00Z', summary: { health_score: 52, waste_monthly_usd: 1610 } },
  { id: 'rep-1', type: 'audit', created_at: '2026-08-05T11:30:00Z', viewed_at: '2026-08-05T11:41:00Z', summary: { health_score: 41, waste_monthly_usd: 2380 } },
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
    spend: { month_usd: 1240, month_budget_usd: 1950, pace_line: 'On pace - 64% spent, 68% of the month gone' },
  },
  'GET /api/app/approvals': { pending },
  'GET /api/app/ledger': { entries: ledger },
  'GET /api/app/reports': { reports },
  'GET /api/app/settings': {
    settings: {
      plan_line: 'Core · $129/mo (active)',
      autopilot: { negatives: false, budgets: false, counting: false },
      connection_status: 'Google connection healthy.',
      weekly: { timezone: 'Asia/Dubai', next_run_at: null, next_check_days: null, last_runs: [] },
      emails: { reports: true, address: 'hello@glowstudio.ae' },
      business: { name: 'Glow Studio', website: 'glowstudio.ae', currency: 'USD', band: '4k' },
    },
  },
  'GET /api/app/discovery': {
    matched: [
      { id: 'a1', kind: 'ads_account', external_id: '642-459-1230', display_name: 'Glow Studio - Ads', linked: true },
      { id: 'a2', kind: 'ga4_property', external_id: '3418867', display_name: 'Glow Studio - Analytics', linked: true },
      { id: 'a3', kind: 'gtm_container', external_id: 'GTM-K2P9QX', display_name: 'glowstudio.ae', linked: true },
    ],
    unmatched: [
      { id: 'a4', kind: 'ga4_property', external_id: '2207114', display_name: 'Old site (2023)', linked: false },
    ],
    doors: {
      ads_account: { state: 'choose', matched: [], suggested: 'a1', candidates: [
        { id: 'a1', kind: 'ads_account', external_id: '642-459-1230', display_name: 'Glow Studio - Ads', spend_30d_usd: 1240, test_account: false },
        { id: 'a5', kind: 'ads_account', external_id: '901-220-4471', display_name: 'Glow Studio (old)', spend_30d_usd: 0, test_account: false },
      ] },
      ga4_property: { state: 'matched', matched: [{ id: 'a2', kind: 'ga4_property', external_id: '3418867', display_name: 'Glow Studio - Analytics' }], candidates: [], suggested: null },
      gtm_container: { state: 'matched', matched: [{ id: 'a3', kind: 'gtm_container', external_id: 'GTM-K2P9QX', display_name: 'glowstudio.ae' }], candidates: [], suggested: null },
    },
    campaigns: [
      { id: '11', name: 'Brand - Dubai', status: 'enabled', spend_30d_usd: 310 },
      { id: '12', name: 'Gel nails - Dubai', status: 'enabled', spend_30d_usd: 720 },
      { id: '13', name: 'Bridal packages', status: 'paused', spend_30d_usd: 0 },
    ],
    site: 'glowstudio.ae',
    no_access: false,
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
      explanation: 'Over 90 days, 11 recurring search themes - nail courses, salon jobs, DIY kits - spent $1,290 and produced zero bookings. Excluding them stops the leak the same day.',
      before_line: 'Your ads show for “nail courses dubai”, “nail technician jobs”, “gel nails at home”…',
      after_line: '14 searches excluded - ads only show to people looking to book.',
    },
  },
  'GET /api/app/journey': {
    journey: {
      journey: 'A',
      stage: 'active',
      gates: { tag: true, approval: true, billing: true },
      instruction_line: 'Everything is set up - your weekly checks run automatically.',
    },
  },
};

// ---------------------------------------------------------------- state
// The customer demo is stateful for the actions that matter: approving or
// dismissing a fix, sending a request, and flipping autopilot. Everything
// mutates session-lifetime copies so the screens stay consistent.
let CS = null;
function cstate() {
  if (!CS) {
    CS = structuredClone({
      pending,
      ledger,
      cumulative: { fixes: 6, waste_removed_usd: 730 },
      autopilot: { negatives: false, budgets: false, counting: false },
      health: 58,
    });
  }
  return CS;
}
const cnow = () => new Date().toISOString();

// The gate in the sample console (gated-platform spec §8). The level is
// previewable per tab (?demo=1&access=locked|unlocked|active) so every gated
// state can be reviewed with the sample report's numbers and no Stripe.
function demoAccess(s) {
  let level = 'active';
  try { level = sessionStorage.getItem('insyt_demo_access') || 'active'; } catch { /* default */ }
  const pendingValue = s.pending.reduce((sum, p) => { const m = /\$([0-9][0-9,]*)/.exec(p.money_line || ''); return sum + (m ? Number(m[1].replace(/,/g, '')) : 0); }, 0);
  return {
    level,
    paid: level !== 'locked',
    plan: level === 'active' ? { tier: s.tier || 'core', status: 'active', label: s.tier === 'autopilot' ? 'Autopilot' : s.tier === 'scale' ? 'Scale' : 'Core', price_usd: s.tier === 'autopilot' ? 199 : s.tier === 'scale' ? 399 : 129 } : null,
    has_customer: level !== 'locked',
    credit_applies: level === 'unlocked',
    band: '4k',
    price_usd: 129,
    prices: { core: 129, autopilot: 199, scale: 399 },
    waste_monthly_usd: 1240,
    currency: 'USD',
    pending_count: s.pending.length,
    pending_value_usd: pendingValue,
    has_report: true,
    findings_count: 7,
    fix_access: 'ready',
  };
}
const gatedPending = (s, level) => (level === 'locked' ? s.pending.map((p) => ({ id: p.id, title: p.title, money_line: p.money_line, finding_id: p.finding_id || null })) : s.pending);

// A real-shaped report for the sample tenant (/app/report/rep-1): the sample
// audit's findings as a snapshot, ids matching the pending changes by title
// so "Fix this" works in the demo exactly as it does for a real tenant.
function demoReport(s, level, id) {
  const audit = sampleAudit;
  const byTitle = new Map(s.pending.map((p) => [p.title, p]));
  const snapshot = audit.findings.map((f, i) => {
    const usd = /\$([0-9][0-9,]*)/.exec(f.money || '');
    const chg = byTitle.get(f.title);
    if (chg && !chg.finding_id) chg.finding_id = `f-${i}`;
    return { finding_id: `f-${i}`, severity: f.severity, title: f.title, explanation: f.body, money_impact_monthly_usd: usd ? Number(usd[1].replace(/,/g, '')) : 0, payload: { fix_detail: f.fix, locked: true }, status: 'open' };
  });
  return {
    id, type: id === 'rep-1' ? 'signup' : 'weekly', created_at: '2026-08-17T07:00:00Z', unlocked: level !== 'locked',
    summary: { currency: 'USD', waste_monthly_usd: audit.wasteMonthly, health_score: audit.health, counts: audit.counts, exec_summary: 'We checked your ads, your tracking and your counting, line by line. This is the sample account.' },
    findings_snapshot: snapshot,
  };
}

// Home overview for the sample tenant at every gate level (richer-platform
// spec §8): a 28-day series, two watches, the three accounts, one alert.
function demoOverview(s, level) {
  const now = Date.now();
  const days = [];
  for (let i = 27; i >= 0; i -= 1) {
    const d = new Date(now - i * 86_400_000);
    const dow = d.getUTCDay();
    const base = dow === 5 || dow === 6 ? 34 : 58;
    const wobble = ((i * 7) % 11) - 5;
    days.push({ date: d.toISOString().slice(0, 10), spend_usd: base + wobble, conversions: dow === 0 ? 1 : 2 + ((i * 3) % 3) });
  }
  const sunday = (weeksAgo) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 7 * weeksAgo) || 7)); d.setUTCHours(3, 0, 0, 0); return d.toISOString(); };
  const lastCheck = sunday(0);
  const active = level === 'active';
  const appliedFixes = s.ledger.filter((e) => /applied/.test(e.event)).length;
  const nextDays = (7 - new Date(now + 4 * 3600_000).getUTCDay()) % 7 || 0;
  return {
    spend: { month_usd: 1240, month_budget_usd: 1950, pace_line: 'On pace - 64% spent, 68% of the month gone' },
    waiting: { approved: 0, oldest_at: null, needs_fix_access: false },
    running: null,
    failed_last: false,
    site: { consent_tool: 'Cookiebot', other_tools: ['Meta'], whatsapp: true, phone: true, server_side_gtm: false },
    waste_monthly_usd: 1240,
    recovered: active ? { fixes: s.cumulative.fixes, usd: s.cumulative.waste_removed_usd } : { fixes: 0, usd: 0 },
    this_week: {
      last_check_at: lastCheck, last_check_type: 'weekly', findings: 7, next_check_days: nextDays,
      applied: active ? Math.max(3, appliedFixes) : 0, verified: active ? 2 : 0, watching: active ? Math.max(1, appliedFixes - 2) : 0, reverted: 0,
    },
    accounts: [
      { kind: 'ads_account', label: 'Google Ads', href: '/app/connected', name: 'Glow Studio - Ads', external_id: '642-459-1230', status: 'ok', read_at: lastCheck },
      { kind: 'ga4_property', label: 'Analytics', href: '/app/connected/analytics', name: 'Glow Studio - Analytics', external_id: '3418867', status: 'ok', read_at: lastCheck },
      { kind: 'gtm_container', label: 'Tag Manager', href: '/app/connected/tag-manager', name: 'glowstudio.ae', external_id: 'GTM-K2P9QX', status: 'ok', read_at: lastCheck },
    ],
    alerts: [
      { id: 'al-1', severity: 'warning', kind: 'spend_spike', title: 'Yesterday cost 2.4x a normal day', at: new Date(now - 26 * 3600_000).toISOString(), acked: !!(s.ackedAlerts && s.ackedAlerts.has('al-1')) },
    ],
    performance: {
      days,
      checks: [sunday(0), sunday(1), sunday(2), sunday(3)],
      fixes: active ? [{ at: sunday(1), title: 'Excluded 14 searches that never book' }, { at: sunday(2), title: 'Moved budget to the campaign that books' }] : [],
    },
  };
}

function demoRuns() {
  const sunday = (weeksAgo) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 7 * weeksAgo) || 7)); d.setUTCHours(3, 10, 0, 0); return d.toISOString(); };
  return [
    { id: 'run-3', type: 'weekly', status: 'complete', started_at: sunday(0), finished_at: sunday(0) },
    { id: 'run-2', type: 'weekly', status: 'degraded', started_at: sunday(1), finished_at: sunday(1) },
    { id: 'run-1', type: 'signup_audit', status: 'complete', started_at: sunday(2), finished_at: sunday(2) },
  ];
}

function customerDemo(path, method, body) {
  const s = cstate();
  const p = path.split('?')[0];
  const access = demoAccess(s);

  if (method === 'GET') {
    if (p === '/api/app/access') return { access };
    if (p.startsWith('/api/app/report/')) {
      const report = demoReport(s, access.level, p.split('/')[4]);
      // One receipt on a finding no pending change claims, at active only.
      const receipts = {};
      if (access.level === 'active') {
        const claimed = new Set(s.pending.map((x) => x.finding_id).filter(Boolean));
        const f = report.findings_snapshot.find((x) => !claimed.has(x.finding_id));
        if (f) receipts[f.finding_id] = { ...RECEIPTS['chg-0'], finding_id: f.finding_id };
      }
      return { report, pending: gatedPending(s, access.level), receipts, access };
    }
    if (p === '/api/app/home') {
      const base = DEMO['GET /api/app/home'];
      return {
        ...structuredClone(base),
        health: { ...structuredClone(base.health), score: s.health },
        pending: s.pending,
        cumulative: access.level === 'active' ? s.cumulative : null,
        plan: access.level === 'active' ? { tier: access.plan.tier, label: access.plan.label, band: '4k' } : { tier: null, label: 'Free check', band: '4k' },
        access,
      };
    }
    if (p === '/api/app/overview') return { overview: demoOverview(s, access.level), access };
    if (p === '/api/app/runs') return { runs: demoRuns() };
    if (p === '/api/app/approvals') return { pending: gatedPending(s, access.level), access };
    if (p === '/api/app/ledger') return { entries: access.level === 'active' ? s.ledger : s.ledger.filter((e) => !/applied|reverted/.test(e.event)), pending: gatedPending(s, access.level), receipts: access.level === 'active' ? structuredClone(RECEIPTS) : {}, access };
    if (p === '/api/app/settings') {
      const base = structuredClone(DEMO['GET /api/app/settings']);
      base.settings.autopilot = { ...s.autopilot };
      base.settings.assistant_enabled = true; // demo consoles first (§7.6)
      base.settings.plan_line = access.level === 'active' ? `${access.plan.label} · $${access.plan.price_usd}/mo (active)` : 'Free check, no plan yet';
      const nextDays = (7 - new Date(Date.now() + 4 * 3600_000).getUTCDay()) % 7 || 7;
      base.settings.weekly = { ...base.settings.weekly, next_run_at: new Date(Date.now() + nextDays * 86_400_000).toISOString().slice(0, 10), next_check_days: nextDays, last_runs: demoRuns() };
      if (s.emails) base.settings.emails = { ...base.settings.emails, ...s.emails };
      if (s.business) base.settings.business = { ...base.settings.business, ...s.business };
      base.access = access;
      return base;
    }
    if (p === '/api/app/chat') {
      if (!s.chat) s.chat = [];
      return { conversation_id: 'demo', messages: s.chat, usage: { pct: 12, consented: false, included_usd: 30 } };
    }
    if (p === '/api/app/drafts') {
      if (!s.drafts) {
        s.drafts = [{ id: 'd1', status: 'draft', template: 'generic', name: 'Gel nails - Dubai', budget_daily_usd: 25,
          plain: { headline: 'Your ad: Gel nails - Dubai', who_sees_it: 'This shows to people searching for what you offer near Dubai.', what_it_says: '', what_you_pay: 'Up to $25 a day. You only pay when someone clicks. It starts switched off - nothing spends until you say go.', safety_line: 'We checked your setup first, so every click gets counted correctly from day one.' },
          gates: { ok: true, blockers: [], steps: [] },
          ad_groups: [{ name: 'Gel nails', rsa: { headlines: ['Gel Nails in Dubai', 'Book Gel Nails Today', 'The Nail DXB - Gel Nails', 'See Prices & Availability', 'Rated by Real Customers', 'Fast, Friendly Service', 'Easy Online Booking', 'Get a Quote in Minutes'], descriptions: ['Looking for gel nails in Dubai? The Nail DXB makes booking simple - clear prices, real reviews.', 'Book online in under a minute, or message us with any question.', 'Local, reliable and rated by customers like you.'], pinned: {} } }],
          created_at: '2026-08-26T09:00:00Z' }];
      }
      return { drafts: s.drafts };
    }
    if (p === '/api/app/setup') return { steps: [{ key: 'ga4', label: 'Visit tracking', done: true }, { key: 'gtm', label: 'Tracking code on your site', done: true }, { key: 'goal', label: 'Counting customer actions', done: true }, { key: 'billing', label: 'Ad money connected to Google', done: true }], journey: 'A' };
    if (p === '/api/app/exceptions') {
      if (!s.exceptions) {
        s.exceptions = [{ id: 'ex1', summary_text: 'Excluded 3 wasted searches from "Brand - Dubai"', target: 'campaign:11:negatives', created_from: 'revert', created_at: '2026-08-20T09:12:00Z' }];
      }
      return { exceptions: s.exceptions };
    }
    return undefined;
  }

  if (method !== 'POST') return undefined;

  // The sample console answers like the server: a write that needs a plan is
  // a 402 with plan_required, and the sheet opens over the screen.
  const needsPlan = access.level !== 'active' && (
    p.startsWith('/api/app/approve/') || p.startsWith('/api/app/revert/') || p === '/api/app/autopilot' || p === '/api/app/approve-batch'
    || /^\/api\/app\/drafts\/[^/]+\/(approve|enable)$/.test(p) || /^\/api\/app\/connected\/ads\/campaigns\/\d+\/(pause|negatives)$/.test(p));
  if (needsPlan) return { status: 402, error: 'This needs a plan. Nothing has changed.', plan_required: true, plan_url: '/app/plan' };
  if (p === '/api/checkout/subscribe') {
    s.tier = (body && body.tier) || 'core';
    return { url: null, demo: true };
  }

  {
    const m = /^\/api\/app\/drafts\/([^/]+)\/(approve|enable|dismiss|edit)$/.exec(p);
    if (m) {
      const d = (s.drafts || []).find((x) => x.id === m[1]);
      if (!d) return { ok: false };
      if (m[2] === 'approve') { d.status = 'created_paused'; s.ledger.unshift({ id: `l-${Date.now()}`, event: 'fix_applied', actor: 'user', summary_text: `Created "${d.name}" in Google Ads. It is paused and spends nothing until you switch it on.`, created_at: cnow() }); }
      if (m[2] === 'enable') { d.status = 'enabled'; s.ledger.unshift({ id: `l-${Date.now()}`, event: 'campaign_launched', actor: 'user', summary_text: `"${d.name}" is live. Up to $${d.budget_daily_usd} a day; one tap pauses it any time.`, created_at: cnow() }); }
      if (m[2] === 'dismiss') d.status = 'dismissed';
      if (m[2] === 'edit' && body && body.ad_groups) { for (const g of body.ad_groups) { const t = d.ad_groups.find((x) => x.name === g.name); if (t) t.rsa = { ...t.rsa, ...g.rsa }; } return { ok: true, spec: { ad_groups: d.ad_groups } }; }
      return { ok: true, status: d.status };
    }
  }
  if (p === '/api/app/chat') {
    const t = String((body && body.text) || '');
    if (!s.chat) s.chat = [];
    s.chat.push({ id: `u-${Date.now()}`, role: 'user', text: t });
    let reply; let card = null;
    const m = /(lower|raise|set|change).*?(\d+)/i.exec(t);
    if (/budget/i.test(t) && m) {
      const amt = Number(m[2]);
      card = { id: `c-${Date.now()}`, summary: `${/lower|reduce|cut/i.test(t) ? 'Lower' : 'Set'} "Brand - Dubai" daily budget $25 → $${amt}`, before_line: '"Brand - Dubai" runs on $25 a day', after_line: `"Brand - Dubai" runs on $${amt} a day` };
      s.pending.unshift({ id: card.id, title: card.summary, money_line: null, explanation: `You asked: "${t}"`, before_line: card.before_line, after_line: card.after_line, ask_reason: 'you asked for it in chat' });
      reply = `Drafted: ${card.summary}. The card is in your approvals; nothing changes until you tap it.`;
    } else if (/pause|stop/i.test(t) && /autopilot/i.test(t)) {
      s.autopilot = { negatives: false, budgets: false, counting: false };
      reply = 'Done. Autopilot is off for everything; we will ask before every change from now on.';
    } else if (/spend|spent|pace|budget/i.test(t)) {
      reply = 'As of today you have spent $1,240 of a $1,950 month budget. On pace: 64% spent with 68% of the month gone. This is sample data.';
    } else if (/history|last week|changed/i.test(t)) {
      reply = `The most recent change on record: ${s.ledger[0] ? s.ledger[0].summary_text : 'nothing yet'}. This is sample data.`;
    } else {
      reply = 'This is the sample console, so answers come from sample data. In your own account I answer from your stored numbers and say when they are from.';
    }
    s.chat.push({ id: `a-${Date.now()}`, role: 'assistant', text: reply, card });
    return { conversation_id: 'demo', reply, card, system_cards: [], model_version: 'demo' };
  }
  if (p === '/api/app/chat/consent') return { ok: true };
  if (/^\/api\/app\/exceptions\/[^/]+\/clear$/.test(p)) {
    const id = p.split('/')[4];
    s.exceptions = (s.exceptions || []).filter((e) => e.id !== id);
    return { ok: true };
  }

  if (p === '/api/app/approve-batch') {
    const ids = (body && body.ids) || [];
    let approved = 0;
    for (const id of ids) {
      const i = s.pending.findIndex((x) => x.id === id);
      if (i === -1) continue;
      const item = s.pending.splice(i, 1)[0];
      approved += 1;
      s.cumulative.fixes += 1;
      const m = /\$([0-9][0-9,]*)/.exec(item.money_line || item.title || '');
      if (m) s.cumulative.waste_removed_usd += Number(m[1].replace(/,/g, ''));
      s.health = Math.min(96, s.health + 3);
      s.ledger.unshift({ id: `l-${Date.now()}-${approved}`, event: 'change_applied', actor: 'system', summary_text: `Applied: ${item.title}. Reversible with one tap.`, created_at: cnow() });
    }
    return { ok: true, approved, requested: ids.length };
  }
  if (p.startsWith('/api/app/approve/')) {
    const id = p.split('/').pop();
    const i = s.pending.findIndex((x) => x.id === id);
    if (i !== -1) {
      const item = s.pending.splice(i, 1)[0];
      s.cumulative.fixes += 1;
      const m = /\$([0-9][0-9,]*)/.exec(item.money_line || item.title || '');
      if (m) s.cumulative.waste_removed_usd += Number(m[1].replace(/,/g, ''));
      s.health = Math.min(96, s.health + 3);
      s.ledger.unshift({ id: `l-${Date.now()}`, event: 'change_applied', actor: 'system', summary_text: `Applied: ${item.title}. Reversible with one tap.`, created_at: cnow() });
    }
    return { ok: true };
  }
  if (p.startsWith('/api/app/dismiss/')) {
    const id = p.split('/').pop();
    const i = s.pending.findIndex((x) => x.id === id);
    if (i !== -1) s.pending.splice(i, 1);
    return { ok: true };
  }
  if (p === '/api/app/request-change') {
    const text = String((body && body.text) || '').slice(0, 500);
    s.ledger.unshift({ id: `l-${Date.now()}`, event: 'change_requested', actor: 'user', summary_text: `You asked: "${text}". We will draft it as a change for your approval.`, created_at: cnow() });
    return { ok: true };
  }
  if (p === '/api/app/recheck') return { ok: true, run_id: 'demo-run', note: 'On its way - in the sample, nothing changes.' };
  if (p === '/api/app/business') {
    s.business = { ...(s.business || {}) };
    if (body && body.name !== undefined) s.business.name = String(body.name).trim();
    if (body && body.website !== undefined) s.business.website = String(body.website).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    return { ok: true, business_name: s.business.name, website_url: s.business.website };
  }
  if (/^\/api\/app\/alerts\/[^/]+\/ack$/.test(p)) { if (!s.ackedAlerts) s.ackedAlerts = new Set(); s.ackedAlerts.add(p.split('/')[4]); return { ok: true }; }
  if (p === '/api/app/emails') { s.emails = { reports: !!(body && body.reports) }; return { ok: true, reports: s.emails.reports }; }
  if (p === '/api/app/confirm') return { ok: true, run_id: 'demo-run' };
  if (p === '/api/app/access-request') return { ok: true };
  if (p === '/api/app/autopilot') {
    const cats = (body && (body.categories || body)) || {};
    for (const k of ['negatives', 'budgets', 'counting']) s.autopilot[k] = !!cats[k];
    return { ok: true, categories: { ...s.autopilot } };
  }
  return undefined;
}

export function demoData(path, method, body) {
  if (path.startsWith('/api/agency')) {
    const hit = agencyDemo(path, method, body);
    if (hit !== undefined) return hit;
  }
  const stateful = customerDemo(path, method, body);
  if (stateful !== undefined) return stateful;
  const key = `${method} ${path.split('?')[0]}`;
  if (DEMO[key] !== undefined) return DEMO[key];
  if (method === 'POST' && path.startsWith('/api/checkout/')) {
    return { url: null, demo: true };
  }
  if (method === 'POST') return { ok: true };
  return undefined;
}
