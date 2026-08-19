// Generates a sample report (web view, locked + unlocked) from fixture data —
// the first look at build-doc §11.4's priority screen. Run:
//   node packages/report/scripts/sample.js /tmp/out
// Not customer-facing; fixture prose mimics what the narration stage produces.
const fs = require('fs');
const path = require('path');
const { assembleEnvelope } = require('../src/envelope');
const { renderReport } = require('../src/render');
const { runRules, healthScore } = require('../../rules/src/engine');

const mk = (over) => ({
  schema_version: 1, run_id: 'r1', tenant_id: 'tn1', status: 'open',
  first_seen_run_id: 'r1', evidence: { metrics: {}, window_days: 30, queries: [] },
  fix: { available: false }, ...over,
});

const findings = [
  mk({
    rule_id: 'ads.tcpa_blind', layer: 4, severity: 'critical', category: 'wasted_spend',
    title: 'Your biggest campaign is bidding blind',
    explanation: 'The "Lashes & Brows" campaign lets Google bid automatically toward customer actions — but nothing has been recorded for 21 days, so it has been optimising with no signal at all.',
    money: { impact_monthly_usd: 1140, impact_monthly_local: { amount: 4187, currency: 'AED' }, direction: 'waste', confidence: 'estimated' },
    payload: { locked: true, entities: [{ kind: 'campaign', value: 'Lashes & Brows — tCPA' }], fix_detail: 'Pause while tracking is fixed, or fix tracking first and leave it running.' },
    display: { icon: 'eye-off', badge_color: 'critical', sort_weight: 99 },
  }),
  mk({
    rule_id: 'ads.wasted_terms', layer: 4, severity: 'warning', category: 'wasted_spend',
    title: '43 search terms are wasting money',
    explanation: 'Your ads show for searches like DIY and free options — people who will never book. About $340 a month goes to clicks that cannot become customers.',
    money: { impact_monthly_usd: 340, impact_monthly_local: { amount: 1249, currency: 'AED' }, direction: 'waste', confidence: 'measured' },
    payload: {
      locked: true,
      entities: [
        { kind: 'search_term', value: 'free nail course', spend_usd: 41.2, clicks: 38 },
        { kind: 'search_term', value: 'diy gel nails at home', spend_usd: 33.75, clicks: 29 },
        { kind: 'search_term', value: 'nail tech jobs dubai', spend_usd: 28.4, clicks: 31 },
      ],
      fix_detail: 'Add 43 negative keywords at campaign level; full list attached.',
    },
    display: { icon: 'trending-down', badge_color: 'warning', sort_weight: 73 },
  }),
  mk({
    rule_id: 'gtm.legacy_debris', layer: 1, severity: 'warning', category: 'config_debris',
    title: 'Outdated tracking is still running',
    explanation: 'Two pieces of old tracking stopped collecting data in 2023 but still load on every page, slowing your site for nothing.',
    money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
    payload: { locked: true, entities: [{ kind: 'gtm_tag', value: 'UA — Old Analytics' }, { kind: 'gtm_tag', value: 'UA — Remarketing 2019' }], fix_detail: 'Pause both old tags.' },
    display: { icon: 'archive', badge_color: 'warning', sort_weight: 60 },
  }),
  mk({
    rule_id: 'ads.budget_constrained_winner', layer: 4, severity: 'opportunity', category: 'opportunity',
    title: 'Your best campaign keeps running out of budget',
    explanation: '"Brand — Search" wins customers at less than half your average cost, but its budget runs out 25% of the time. A modest raise buys more of your best traffic.',
    money: { impact_monthly_usd: 225, direction: 'opportunity', confidence: 'estimated' },
    payload: { locked: true, entities: [{ kind: 'campaign', value: 'Brand — Search' }], fix_detail: 'Raise daily budget from $30 to $38.' },
    display: { icon: 'trending-up', badge_color: 'opportunity', sort_weight: 48 },
  }),
  mk({
    rule_id: 'ga4.ads_link_recent', layer: 2, severity: 'info', category: 'context',
    title: 'Your tracking connection is new',
    explanation: 'The connection between your visit tracking and your ads was made 9 days ago — history before that simply does not exist.',
    money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
    payload: { locked: false, entities: [], fix_detail: 'Nothing to do — numbers fill in over the coming weeks.' },
    display: { icon: 'clock', badge_color: 'info', sort_weight: 10 },
  }),
];

const env = assembleEnvelope({
  run: { id: 'r1', type: 'signup_audit', status: 'complete' },
  findings,
  ledgerCumulative: null,
  narrativeSlots: {
    exec_summary: 'One serious problem is costing you real money: your biggest campaign has been bidding with no conversion signal for three weeks. Everything else is fixable in one round of approvals.',
    since_last_week: '',
  },
});

const score = healthScore(findings);
const outDir = process.argv[2] || '/tmp/report-sample';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report-locked.html'), renderReport(env, { unlocked: false, healthScore: score, mode: 'web', links: { unlock_url: '#unlock' } }));
fs.writeFileSync(path.join(outDir, 'report-unlocked.html'), renderReport(env, { unlocked: true, healthScore: score, mode: 'web' }));
console.log(`health=${score} waste=$${env.totals.waste_monthly_usd}/mo → ${outDir}`);
