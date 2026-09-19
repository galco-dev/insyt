// Email template set - build-doc §12, master §4/§5.
// Every template: ONE action maximum (enforced structurally - a template has
// at most one `cta`), Geist-safe HTML, plain register. This whole tree is
// jargon-linted in CI. Streams: 'transactional' (alerts./tryinsyt.com) vs
// 'report' (mail./tryinsyt.com).
//
// Each template: { id, stream, subject(v), paragraphs(v) -> [..], cta?(v) -> {label,url} }
// Vars are engine-computed; templates never do arithmetic.

const FONT = "'Geist', Helvetica, Arial, sans-serif";
const ACCENT = '#000d14'; // brand ink - headings
const CTA = '#2563eb'; // brand blue - the one action (kit v2, Sep 2026)

function shell({ subject, paragraphs, cta }) {
  const body = paragraphs.map((p) => `<p style="font-family:${FONT};font-size:15px;color:#333;line-height:1.5;margin:0 0 14px 0;">${p}</p>`).join('\n');
  const button = cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px 0;"><tr><td style="background:${CTA};border-radius:6px;">
      <a href="${cta.url}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${cta.label}</a>
    </td></tr></table>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;"><tr><td style="padding:32px 20px;">
<img src="https://app.tryinsyt.com/app/brand/insyt-wordmark-black.png" alt="Insyt" height="22" style="height:22px;width:auto;display:block;margin-bottom:22px;border:0;" />
<div style="font-family:${FONT};font-size:20px;font-weight:600;color:${ACCENT};margin-bottom:18px;">${subject}</div>
${body}
${button}
<p style="font-family:${FONT};font-size:12px;color:#727272;margin-top:24px;">Insyt - your ads and tracking, checked and fixed every week, with your approval.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const T = (id, stream, subject, paragraphs, cta) => ({ id, stream, subject, paragraphs, cta });
const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TEMPLATES = [
  T('audit_ready', 'transactional',
    (v) => `Your audit is ready - ${v.issue_count} issue${v.issue_count === 1 ? '' : 's'} found`,
    (v) => [
      `We finished checking ${v.site}. Your account health score is ${v.health_score} out of 100.`,
      v.waste_monthly ? `About ${v.waste_monthly} a month is going to waste. The full report shows exactly where, and the fixes.` : 'The full report shows everything we checked.',
    ],
    (v) => ({ label: 'See your report', url: v.report_url })),

  T('access_request', 'transactional',
    (v) => `Could you connect Google Ads for ${v.site || 'your website'}?`,
    (v) => [
      `${v.from_name || 'The owner'} is setting up Insyt to check the ads and tracking for ${v.site || 'their website'}, and your Google account is the one that can see them.`,
      'It takes one tap. Insyt only reads at first: nothing changes in any account without an approval.',
    ],
    (v) => ({ label: 'Connect with Google', url: v.start_url || 'https://app.tryinsyt.com/app/start' })),

  T('viewer_invite', 'transactional',
    (v) => `${v.from_name || 'The owner'} invited you to see ${v.business || 'their'} ads on Insyt`,
    (v) => [
      `${v.from_name || 'The owner'} wants you to see how the ads for ${v.business || 'the business'} are doing: the weekly report, what is waiting for a yes, and the history.`,
      'You can look at everything. Approving changes stays with the owner. The link signs you in for 30 days.',
    ],
    (v) => ({ label: 'Open Insyt', url: v.join_url || 'https://app.tryinsyt.com/app' })),

  T('join_request', 'transactional',
    (v) => `${v.from_email || 'Someone'} wants to see ${v.business || 'your business'} on Insyt`,
    (v) => [
      `${v.from_email || 'Someone'} signed in to Insyt with ${v.site || 'your website'} and it already belongs to your account.`,
      'Add them as a viewer with one tap: they see everything, approvals stay yours. Ignore this if you do not know them.',
    ],
    (v) => ({ label: 'Add them', url: v.approve_url || 'https://app.tryinsyt.com/app/settings' })),

  T('pay_link', 'transactional',
    (v) => `${v.from_name || 'Someone'} asked you to start the Insyt plan for ${v.business || 'their business'}`,
    (v) => [
      `Insyt checks and fixes the Google Ads for ${v.business || 'the business'} every week, with every change approved first. ${v.from_name || 'They'} chose the ${v.tier || 'Core'} plan at ${v.price || 'the listed price'} a month.`,
      'This link opens the secure card page. It is only for starting the plan; nothing else is shared.',
    ],
    (v) => ({ label: 'Pay and start the plan', url: v.pay_url || 'https://app.tryinsyt.com/app/plan' })),

  T('agency_welcome', 'transactional',
    (v) => `${v.agency || 'Your agency'} is set up on Insyt`,
    (v) => [
      `Hello${v.name ? ` ${v.name}` : ''}. ${v.agency || 'Your agency'} now has an Insyt console: add your client accounts, invite your team, and every check, alert and approval across the portfolio lands in one place.`,
      'Start with one account. Add the client\'s email and we ask them to connect; the first audit runs the day they do.',
    ],
    (v) => ({ label: 'Open the console', url: v.console_url || 'https://app.tryinsyt.com/app/agency' })),

  T('report_ready_copy', 'report',
    (v) => `${v.agency || 'Your agency'} has this week's check for ${v.site || 'your website'}`,
    (v) => [
      `The weekly check for ${v.site || 'your website'} is done. ${v.agency || 'Your agency'} looks after it: they review what we found and decide what to do, and nothing changes in your accounts without their approval.`,
      v.held ? 'The report opens once they have looked at it.' : 'You can read the report any time.',
    ],
    (v) => ({ label: 'See the report', url: v.report_url || 'https://app.tryinsyt.com/app' })),

  T('agency_digest', 'transactional',
    (v) => `${v.agency || 'Your agency'} this morning: ${v.alerts || 0} alert${v.alerts === 1 ? '' : 's'}${v.reviews ? `, ${v.reviews} report${v.reviews === 1 ? '' : 's'} to review` : ''}`,
    (v) => [
      `Good morning${v.name ? ` ${v.name}` : ''}. Waiting on you across your accounts:`,
      ...((v.lines || []).map((l) => `- ${l}`)),
      'Acknowledging an alert or approving a report in the console takes it off tomorrow\'s list.',
    ],
    (v) => ({ label: 'Open the console', url: v.console_url || 'https://app.tryinsyt.com/app/agency' })),

  T('agency_stepped_back', 'transactional',
    (v) => `${v.agency || 'Your agency'} has stepped back from ${v.business || 'your account'} on Insyt`,
    (v) => [
      `${v.agency || 'Your agency'} is no longer looking after ${v.business || 'your account'} on Insyt. The weekly checks and emails have stopped, and nothing in your Google accounts has changed.`,
      'Your history stays where it was. Sign in any time to pick things up yourself, or ignore this and nothing more happens.',
    ],
    () => ({ label: 'Open Insyt', url: 'https://app.tryinsyt.com/app' })),

  T('agency_invite', 'transactional',
    (v) => `${v.agency || 'Your agency'} invited you to Insyt`,
    (v) => [
      `${v.from_name || 'An admin'} added you to ${v.agency || 'the agency'}'s Insyt console as ${v.role_label || 'an account manager'}.`,
      'One tap signs you in with Google. Every approval you make is logged under your name.',
    ],
    (v) => ({ label: 'Join with Google', url: v.join_url || 'https://app.tryinsyt.com/app/agency' })),

  T('unlock_receipt', 'transactional',
    () => 'Your full report is unlocked',
    (v) => [
      `Payment received - ${v.amount} - and your full report is now open, including every detail and every fix.`,
      'This amount is credited to your first month if you subscribe.',
    ],
    (v) => ({ label: 'Open the full report', url: v.report_url })),

  T('report_weekly_core', 'report',
    (v) => `This week: ${v.headline}`,
    (v) => [v.exec_summary, 'Everything below waits for your approval - nothing changes until you say so.'],
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
    (v) => [`We watched for 48 hours after applying this change. Everything looks right - ${v.verify_detail}.`],
    null),

  T('revert_notice', 'transactional',
    (v) => `We undid a change: ${v.fix_summary}`,
    (v) => [
      `After applying this change we watched your numbers, and they moved the wrong way - so we put everything back exactly as it was on ${v.reverted_at}.`,
      'No action needed from you. We flagged it so the same change will not be suggested again without a second look.',
    ],
    null),

  T('revert_one_tap', 'transactional',
    (v) => `Something looks off since: ${v.fix_summary}`,
    (v) => [`Your numbers moved the wrong way after this change. One tap puts everything back exactly as it was.`],
    (v) => ({ label: 'Undo this change', url: v.revert_url })),

  T('tag_guide_shopify', 'transactional', () => 'One paste and your tracking is live',
    () => ['Shopify keeps a place for this in your theme. The guide shows the exact taps: copy your tracking code, paste it in, save. About a minute. We check your shop from our side, so there is nothing to confirm.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tag_guide_wordpress', 'transactional', () => 'One paste and your tracking is live',
    () => ['WordPress has a place for this in your theme, or in the header plugin you already use. The guide shows both, with the exact taps. Prefer to hand it off? The guide has a button for that.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tag_guide_webflow', 'transactional', () => 'One paste and your tracking is live',
    () => ['Webflow has a box made for this in your project settings. Copy your tracking code, paste it in, publish. About a minute. We check your site from our side afterwards.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tag_guide_wix', 'transactional', () => 'One short paste and your tracking is live',
    () => ['Wix has a box made for this. The guide shows the exact taps with pictures - copy your tracking ID, paste it in, save. Thirty seconds.'],
    (v) => ({ label: 'Open the picture guide', url: v.guide_url })),
  T('tag_guide_squarespace', 'transactional', () => 'One paste and your tracking is live',
    () => ['The guide walks you to the right panel with pictures - one paste, save, done. We verify it from our side.'],
    (v) => ({ label: 'Open the picture guide', url: v.guide_url })),
  T('tag_guide_other', 'transactional', () => 'One paste and your tracking is live',
    () => ['Your tracking code goes on every page of your website, just before the closing head tag. The guide has the code ready to copy and a button to send it to whoever looks after your site. We check from our side afterwards.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tracking_handoff', 'transactional', (v) => `${v.business || 'A client'} asked us to send you their tracking code`,
    (v) => [
      `${v.business || 'Your client'} uses Insyt to look after their Google Ads. They asked us to send you the tracking code for ${v.site || 'their website'}.`,
      'It goes on every page, just before the closing head tag. Once it is live we verify it automatically and nothing else is needed from you.',
      v.code ? `Code to paste, on every page just before the closing head tag:<br><code style="display:block;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:12px;background:#f4f4f4;padding:10px;border-radius:6px;">${escapeHtml(v.code)}</code>` : '',
    ].filter(Boolean),
    (v) => ({ label: 'Open the guide', url: v.guide_url })),

  T('tracking_disappeared', 'transactional', () => 'Your tracking disappeared from your site',
    () => ['Your tracking was working and has now vanished - this usually happens after a site edit or theme change. Until it is back, visits and enquiries are going uncounted.'],
    (v) => ({ label: 'Reinstall in one tap', url: v.guide_url })),

  T('daily_alert', 'transactional', (v) => (v.severity === 'critical' ? 'Something needs a look today' : 'Something moved in your ads account'),
    (v) => [v.title, 'We check every account daily so nothing waits for the weekly report. Your dashboard has the detail; if a fix is needed, it lands there for your approval.'],
    (v) => ({ label: 'Open the dashboard', url: v.app_url })),

  T('tag_verified', 'transactional', () => '✓ Your tracking is live',
    (v) => [`We checked ${v.pages_checked} pages on your site - your tracking is installed, firing, and recording visits. Nothing more to do.`],
    null),

  T('tag_corrective', 'transactional', () => 'Almost there - one setting left',
    (v) => [`Your tracking is installed but only on some pages. ${v.corrective_line}`],
    (v) => ({ label: 'See the one setting', url: v.guide_url })),

  T('tag_nudge_1', 'transactional', () => 'Ready when you are',
    () => ['Your tracking guide is waiting - it takes about thirty seconds. We check automatically, so there is nothing to confirm afterwards.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tag_nudge_2', 'transactional', () => 'Your tracking code, one paste',
    () => ['Still waiting to see your tracking code on your site. The guide has it ready to copy and shows exactly where it goes, with pictures. We verify it the moment it appears.'],
    (v) => ({ label: 'Open the guide', url: v.guide_url })),
  T('tag_nudge_3', 'transactional', () => 'Want us to email your web person instead?',
    () => ['Type the email of whoever helps with your website, and we send them the code and the guide directly. Most web people finish it in a minute.'],
    (v) => ({ label: 'Hand it off', url: v.guide_url })),

  T('first_conversion', 'transactional', () => '✓ Your first tracked enquiry',
    (v) => [`${v.conversion_line} All three of your systems recorded it - ads, tracking, and the counter. The loop is closed.`],
    null),

  T('journey_resume', 'transactional', () => 'Pick up where you left off',
    (v) => [`Your setup is saved exactly where you stopped - ${v.stage_line}. One tap continues it.`],
    (v) => ({ label: 'Continue setup', url: v.resume_url })),

  T('billing_gate', 'transactional', () => 'Last step: connect your ad money to Google',
    () => ['Ad money goes from you straight to Google - we never touch it. This link opens the right page; add a payment method and you are done.'],
    (v) => ({ label: 'Open Google billing', url: v.billing_url })),

  T('launch_live', 'transactional', () => "🚀 You're live",
    (v) => [`Your campaigns are running as of ${v.launched_at}. First report lands in a week - it will read as your baseline.`],
    (v) => ({ label: 'Watch it work', url: v.dashboard_url })),

  T('reconnect_needed', 'transactional', () => 'One tap to reconnect Google',
    () => ['Your Google connection needs a quick refresh - this happens from time to time and takes one tap. Until then, weekly checks are paused.'],
    (v) => ({ label: 'Reconnect', url: v.reconnect_url })),

  T('card_failed_grace', 'transactional', () => 'Your payment did not go through',
    (v) => [`We could not charge your card (attempt ${v.attempt}). We will retry in ${v.next_retry_days} days - your monitoring continues in the meantime, nothing is cut off.`],
    (v) => ({ label: 'Update your card', url: v.portal_url })),

  T('milestone_smart_bidding', 'report', () => 'Your account is ready for smart bidding',
    (v) => [`You now have ${v.conversions_30d} tracked customer actions in the last 30 days - enough history for Google to bid toward customers automatically. We recommend the switch.`],
    (v) => ({ label: 'Approve the switch', url: v.approve_url })),

  T('graduation_prompt', 'report', () => 'You have approved 10 fixes in a row',
    () => ['Every suggestion lately has met your yes. Autopilot applies the same categories of fix automatically - always reversible, always in the ledger - and frees your inbox.'],
    (v) => ({ label: 'See Autopilot', url: v.plan_url })),

  T('decline_48h', 'transactional', () => 'Your report is still waiting',
    (v) => [`The issues we found - including about ${v.waste_monthly} a month going to waste - are still there. The full detail stays one tap away.`],
    (v) => ({ label: 'Open your report', url: v.report_url })),

  T('report_never_viewed', 'report', () => 'The 60-second version of your report',
    (v) => [v.exec_summary, 'That is the whole story - the report has the detail whenever you want it.'],
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
  const out = {
    id, stream: t.stream, subject,
    html: shell({ subject, paragraphs: t.paragraphs(vars), cta: t.cta ? t.cta(vars) : null }),
  };
  // A template rendered with a missing variable must never reach a customer:
  // "undefined" in a subject line is worse than no email. Callers (the send
  // loop) treat this as a failed send and log it.
  if (/\bundefined\b|\bNaN\b|href="undefined"/.test(`${subject} ${out.html}`)) {
    throw new Error(`template ${id}: missing variable (would render "undefined")`);
  }
  return out;
}

module.exports = { TEMPLATES, byId, renderTemplate };
