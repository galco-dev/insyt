// Email template set — build-doc §12, master §4/§5.
// Every template: ONE action maximum (enforced structurally — a template has
// at most one `cta`), Geist-safe HTML, plain register. This whole tree is
// jargon-linted in CI. Streams: 'transactional' (alerts./tryinsyt.com) vs
// 'report' (mail./tryinsyt.com).
//
// Each template: { id, stream, subject(v), paragraphs(v) -> [..], cta?(v) -> {label,url} }
// Vars are engine-computed; templates never do arithmetic.

const FONT = "'Geist', Helvetica, Arial, sans-serif";
const ACCENT = '#000d14';

function shell({ subject, paragraphs, cta }) {
  const body = paragraphs.map((p) => `<p style="font-family:${FONT};font-size:15px;color:#333;line-height:1.5;margin:0 0 14px 0;">${p}</p>`).join('\n');
  const button = cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px 0;"><tr><td style="background:${ACCENT};border-radius:6px;">
      <a href="${cta.url}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${cta.label}</a>
    </td></tr></table>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;"><tr><td style="padding:32px 20px;">
<div style="font-family:${FONT};font-size:20px;font-weight:600;color:${ACCENT};margin-bottom:18px;">${subject}</div>
${body}
${button}
<p style="font-family:${FONT};font-size:12px;color:#727272;margin-top:24px;">Insyt — your ads and tracking, checked and fixed every week, with your approval.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const T = (id, stream, subject, paragraphs, cta) => ({ id, stream, subject, paragraphs, cta });

const TEMPLATES = [
  T('audit_ready', 'transactional',
    (v) => `Your audit is ready — ${v.issue_count} issue${v.issue_count === 1 ? '' : 's'} found`,
    (v) => [
      `We finished checking ${v.site}. Your account health score is ${v.health_score} out of 100.`,
      v.waste_monthly ? `About ${v.waste_monthly} a month is going to waste. The full report shows exactly where, and the fixes.` : 'The full report shows everything we checked.',
    ],
    (v) => ({ label: 'See your report', url: v.report_url })),

  T('unlock_receipt', 'transactional',
    () => 'Your full report is unlocked',
    (v) => [
      `Payment received — ${v.amount} — and your full report is now open, including every detail and every fix.`,
      'This amount is credited to your first month if you subscribe.',
    ],
    (v) => ({ label: 'Open the full report', url: v.report_url })),

  T('report_weekly_core', 'report',
    (v) => `This week: ${v.headline}`,
    (v) => [v.exec_summary, 'Everything below waits for your approval — nothing changes until you say so.'],
    (v) => ({ label: `Approve ${v.pending_count} fix${v.pending_count === 1 ? '' : 'es'}`, url: v.approve_url })),

  T('report_weekly_autopilot', 'report',
    (v) => `This week: ${v.headline}`,
    (v) => [v.exec_summary, `${v.applied_count} fix${v.applied_count === 1 ? '' : 'es'} applied this week under your automation settings. Every one is reversible.`],
    (v) => ({ label: 'See the full report', url: v.report_url })),

  T('report_deep', 'report',
    () => 'Your deep review is ready',
    (v) => [v.deep_synthesis, 'The full report walks through everything, biggest money first.'],
    (v) => ({ label: 'Read the deep review', url: v.report_url })),

  T('fix_verified_48h', 'transactional',
    (v) => `Verified: ${v.fix_summary}`,
    (v) => [`We watched for 48 hours after applying this change. Everything looks right — ${v.verify_detail}.`],
    null),

  T('revert_notice', 'transactional',
    (v) => `We undid a change: ${v.fix_summary}`,
    (v) => [
      `After applying this change we watched your numbers, and they moved the wrong way — so we put everything back exactly as it was on ${v.reverted_at}.`,
      'No action needed from you. We flagged it so the same change will not be suggested again without a second look.',
    ],
    null),

  T('revert_one_tap', 'transactional',
    (v) => `Something looks off since: ${v.fix_summary}`,
    (v) => [`Your numbers moved the wrong way after this change. One tap puts everything back exactly as it was.`],
    (v) => ({ label: 'Undo this change', url: v.revert_url })),

  T('tag_guide_shopify', 'transactional', () => 'Two taps and your tracking is live',
    () => ['We place your tracking for you — approve our app in your shop admin and everything else happens automatically.'],
    (v) => ({ label: 'Approve in Shopify', url: v.guide_url })),
  T('tag_guide_wordpress', 'transactional', () => 'One click and your tracking is live',
    () => ['Install our plugin with one click — it places your tracking for you. Prefer to hand it off? Reply with the email of whoever helps with your website.'],
    (v) => ({ label: 'Install the plugin', url: v.guide_url })),
  T('tag_guide_webflow', 'transactional', () => 'Two taps and your tracking is live',
    () => ['Approve the connection and we place your tracking on your site and publish it for you.'],
    (v) => ({ label: 'Approve in Webflow', url: v.guide_url })),
  T('tag_guide_wix', 'transactional', () => 'One short paste and your tracking is live',
    () => ['Wix has a box made for this. The guide shows the exact taps with pictures — copy your tracking ID, paste it in, save. Thirty seconds.'],
    (v) => ({ label: 'Open the picture guide', url: v.guide_url })),
  T('tag_guide_squarespace', 'transactional', () => 'One paste and your tracking is live',
    () => ['The guide walks you to the right panel with pictures — one paste, save, done. We verify it from our side.'],
    (v) => ({ label: 'Open the picture guide', url: v.guide_url })),

  T('tracking_disappeared', 'transactional', () => 'Your tracking disappeared from your site',
    () => ['Your tracking was working and has now vanished — this usually happens after a site edit or theme change. Until it is back, visits and enquiries are going uncounted.'],
    (v) => ({ label: 'Reinstall in one tap', url: v.guide_url })),

  T('daily_alert', 'transactional', (v) => (v.severity === 'critical' ? 'Something needs a look today' : 'Something moved in your ads account'),
    (v) => [v.title, 'We check every account daily so nothing waits for the weekly report. Your dashboard has the detail; if a fix is needed, it lands there for your approval.'],
    (v) => ({ label: 'Open the dashboard', url: v.app_url })),

  T('tag_verified', 'transactional', () => '✓ Your tracking is live',
    (v) => [`We checked ${v.pages_checked} pages on your site — your tracking is installed, firing, and recording visits. Nothing more to do.`],
    null),

  T('tag_corrective', 'transactional', () => 'Almost there — one setting left',
    (v) => [`Your tracking is installed but only on some pages. ${v.corrective_line}`],
    (v) => ({ label: 'See the one setting', url: v.guide_url })),

  T('tag_nudge_1', 'transactional', () => 'Ready when you are',
    () => ['Your tracking guide is waiting — it takes about thirty seconds. We check automatically, so there is nothing to confirm afterwards.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tag_nudge_2', 'transactional', () => 'A 30-second video of the whole thing',
    () => ['Here is the entire installation, recorded — thirty seconds, three taps. We will verify it the moment it appears.'],
    (v) => ({ label: 'Watch and do', url: v.video_url })),
  T('tag_nudge_3', 'transactional', () => 'Want us to email your web person instead?',
    () => ['Type the email of whoever helps with your website, and we send them the guide directly. Most web people finish it in a minute.'],
    (v) => ({ label: 'Hand it off', url: v.handoff_url })),

  T('first_conversion', 'transactional', () => '✓ Your first tracked enquiry',
    (v) => [`${v.conversion_line} All three of your systems recorded it — ads, tracking, and the counter. The loop is closed.`],
    null),

  T('journey_resume', 'transactional', () => 'Pick up where you left off',
    (v) => [`Your setup is saved exactly where you stopped — ${v.stage_line}. One tap continues it.`],
    (v) => ({ label: 'Continue setup', url: v.resume_url })),

  T('billing_gate', 'transactional', () => 'Last step: connect your ad money to Google',
    () => ['Ad money goes from you straight to Google — we never touch it. This link opens the right page; add a payment method and you are done.'],
    (v) => ({ label: 'Open Google billing', url: v.billing_url })),

  T('launch_live', 'transactional', () => "🚀 You're live",
    (v) => [`Your campaigns are running as of ${v.launched_at}. First report lands in a week — it will read as your baseline.`],
    (v) => ({ label: 'Watch it work', url: v.dashboard_url })),

  T('reconnect_needed', 'transactional', () => 'One tap to reconnect Google',
    () => ['Your Google connection needs a quick refresh — this happens from time to time and takes one tap. Until then, weekly checks are paused.'],
    (v) => ({ label: 'Reconnect', url: v.reconnect_url })),

  T('card_failed_grace', 'transactional', () => 'Your payment did not go through',
    (v) => [`We could not charge your card (attempt ${v.attempt}). We will retry in ${v.next_retry_days} days — your monitoring continues in the meantime, nothing is cut off.`],
    (v) => ({ label: 'Update your card', url: v.portal_url })),

  T('milestone_smart_bidding', 'report', () => 'Your account is ready for smart bidding',
    (v) => [`You now have ${v.conversions_30d} tracked customer actions in the last 30 days — enough history for Google to bid toward customers automatically. We recommend the switch.`],
    (v) => ({ label: 'Approve the switch', url: v.approve_url })),

  T('graduation_prompt', 'report', () => 'You have approved 10 fixes in a row',
    () => ['Every suggestion lately has met your yes. Autopilot applies the same categories of fix automatically — always reversible, always in the ledger — and frees your inbox.'],
    (v) => ({ label: 'See Autopilot', url: v.plan_url })),

  T('decline_48h', 'transactional', () => 'Your report is still waiting',
    (v) => [`The issues we found — including about ${v.waste_monthly} a month going to waste — are still there. The full detail stays one tap away.`],
    (v) => ({ label: 'Open your report', url: v.report_url })),

  T('report_never_viewed', 'report', () => 'The 60-second version of your report',
    (v) => [v.exec_summary, 'That is the whole story — the report has the detail whenever you want it.'],
    (v) => ({ label: 'Open the report', url: v.report_url })),

  T('monthly_pulse', 'report', () => 'Your month in one line',
    (v) => [`${v.pulse_line} Everything else is steady.`],
    (v) => ({ label: 'See the month', url: v.report_url })),
];

const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

function renderTemplate(id, vars = {}) {
  const t = byId[id];
  if (!t) throw new Error(`unknown template: ${id}`);
  const subject = t.subject(vars);
  return {
    id, stream: t.stream, subject,
    html: shell({ subject, paragraphs: t.paragraphs(vars), cta: t.cta ? t.cta(vars) : null }),
  };
}

module.exports = { TEMPLATES, byId, renderTemplate };
