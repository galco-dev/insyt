// Canned data for demo mode - every /api/app response, shaped exactly like
// the real dashStore payloads, so screens are reviewable before credentials
// exist. Same fictional business as the sample report (Glow Studio).

import { agencyDemo } from '../agency/demo.js';

const pending = [
  {
    id: 'chg-1',
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

const ledger = [
  { id: 'l6', event: 'watch_triggered', actor: 'system', summary_text: 'We started a 48-hour watch on your latest fixes.', created_at: '2026-08-18T09:12:00Z' },
  { id: 'l5', event: 'change_applied', actor: 'system', summary_text: 'Applied: 14 searches excluded from your ads. Reversible with one tap.', created_at: '2026-08-18T09:10:00Z' },
  { id: 'l4', event: 'approval', actor: 'user', summary_text: 'You approved 2 fixes from your inbox.', created_at: '2026-08-18T08:57:00Z' },
  { id: 'l3', event: 'report_sent', actor: 'system', summary_text: 'Weekly report delivered - 7 findings, about $1,240 a month at stake.', created_at: '2026-08-17T07:00:00Z' },
  { id: 'l2', event: 'tag_verified', actor: 'system', summary_text: 'Your tracking is live - checked 12 pages, firing correctly.', created_at: '2026-08-12T15:20:00Z' },
  { id: 'l1', event: 'connection_changed', actor: 'user', summary_text: 'Google connected - read access granted.', created_at: '2026-08-12T15:04:00Z' },
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

function customerDemo(path, method, body) {
  const s = cstate();
  const p = path.split('?')[0];

  if (method === 'GET') {
    if (p === '/api/app/home') {
      const base = DEMO['GET /api/app/home'];
      return {
        ...structuredClone(base),
        health: { ...structuredClone(base.health), score: s.health },
        pending: s.pending,
        cumulative: s.cumulative,
      };
    }
    if (p === '/api/app/approvals') return { pending: s.pending };
    if (p === '/api/app/ledger') return { entries: s.ledger };
    if (p === '/api/app/settings') {
      const base = structuredClone(DEMO['GET /api/app/settings']);
      base.settings.autopilot = { ...s.autopilot };
      base.settings.assistant_enabled = true; // demo consoles first (§7.6)
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
