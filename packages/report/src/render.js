// Report renderer — build-doc §13. ONE renderer, two outputs from the same
// envelope: email HTML (inline styles, table layout) and web view HTML.
// Identical section order. The blur boundary is enforced HERE, server-side:
// when `unlocked` is false, locked payload subtrees NEVER enter the markup —
// placeholders carry only counts. CSS hides nothing because there is nothing
// to hide.
//
// Design tokens from §18.1/18.2 — the marketing site and the app share them.

const path = require('path');
// Copy lives in the linted tree (packages/emails) — the register is the product.
const COPY = require(path.join(__dirname, '..', '..', 'emails', 'copy.json')).report;

const TOKENS = {
  accent: '#000d14',
  critical: '#DC2626',
  warning: '#D97706',
  success: '#16A34A',
  info: '#2563EB',
  opportunity: '#16A34A',
  neutral100: '#f7f7f7',
  neutral400: '#e6e6e6',
  neutral900: '#727272',
  radius: '6px',
  font: "'Geist', Helvetica, Arial, sans-serif",
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => esc(vars[k] ?? ''));

function fmtMoney(usd, local) {
  if (local && local.amount != null && local.currency) {
    return `${esc(local.currency)} ${Math.round(local.amount).toLocaleString('en-US')}`;
  }
  return `$${Math.round(usd || 0).toLocaleString('en-US')}`;
}

function sevColor(severity) { return TOKENS[severity] || TOKENS.info; }

function healthScoreBlock(score) {
  const color = score >= 80 ? TOKENS.success : score >= 50 ? TOKENS.warning : TOKENS.critical;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="center" style="padding:24px 0 8px 0;">
      <div style="font-family:${TOKENS.font};font-size:56px;font-weight:600;color:${color};line-height:1;">${score}</div>
      <div style="font-family:${TOKENS.font};font-size:14px;color:${TOKENS.neutral900};margin-top:4px;">${esc(COPY.health_label)}</div>
    </td></tr></table>`;
}

function moneyHeadline(envelope) {
  const w = envelope.totals.waste_monthly_usd;
  const text = w > 0
    ? fill(COPY.money_headline_waste, { amount: `$${w.toLocaleString('en-US')}` })
    : COPY.money_headline_clean;
  return `<div style="font-family:${TOKENS.font};font-size:24px;font-weight:600;color:${TOKENS.accent};text-align:center;padding:8px 16px 24px 16px;">${text}</div>`;
}

/** The blur boundary. Locked + not unlocked → counts only, no entities, no fix detail. */
function payloadBlock(finding, unlocked) {
  const p = finding.payload || {};
  const showFull = unlocked || p.locked === false;
  if (showFull) {
    const rows = (p.entities || []).slice(0, 30).map((e) => `<tr>
        <td style="font-family:${TOKENS.font};font-size:13px;padding:4px 8px;border-bottom:1px solid ${TOKENS.neutral400};">${esc(e.value)}</td>
        <td style="font-family:${TOKENS.font};font-size:13px;padding:4px 8px;border-bottom:1px solid ${TOKENS.neutral400};color:${TOKENS.neutral900};text-align:right;">${e.spend_usd != null ? '$' + Math.round(e.spend_usd).toLocaleString('en-US') : ''}</td>
      </tr>`).join('');
    const fixLine = p.fix_detail ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.accent};padding:8px;">${esc(p.fix_detail)}</div>` : '';
    return `${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : ''}${fixLine}`;
  }
  const count = (p.entities || []).length;
  if (count === 0) return `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};padding:8px;">${esc(COPY.locked_fix_placeholder)}</div>`;
  const kind = (p.entities[0] && p.entities[0].kind) || 'default';
  const noun = COPY.noun_for_kind[kind] || COPY.noun_for_kind.default;
  return `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};background:${TOKENS.neutral100};border:1px dashed ${TOKENS.neutral400};border-radius:${TOKENS.radius};padding:12px;text-align:center;">${fill(COPY.locked_placeholder, { count, noun })}</div>`;
}

function findingCard(finding, unlocked) {
  const color = sevColor(finding.severity);
  const money = finding.money && finding.money.impact_monthly_usd > 0
    ? `<span style="float:right;font-weight:600;color:${finding.money.direction === 'opportunity' ? TOKENS.success : color};">${finding.money.confidence === 'estimated' ? '~' : ''}${fmtMoney(finding.money.impact_monthly_usd, finding.money.impact_monthly_local)}/mo</span>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;border:1px solid ${TOKENS.neutral400};border-left:4px solid ${color};border-radius:${TOKENS.radius};">
    <tr><td style="padding:12px 16px;">
      <div style="font-family:${TOKENS.font};font-size:11px;font-weight:500;color:${color};text-transform:uppercase;letter-spacing:.04em;">${esc(COPY.severity_labels[finding.severity] || finding.severity)}</div>
      <div style="font-family:${TOKENS.font};font-size:16px;font-weight:600;color:${TOKENS.accent};padding:4px 0;">${esc(finding.title || '')}${money}</div>
      <div style="font-family:${TOKENS.font};font-size:14px;color:#333;padding-bottom:8px;">${esc(finding.explanation || '')}</div>
      ${payloadBlock(finding, unlocked)}
    </td></tr></table>`;
}

const { renderPerformanceSection } = require('./performance');

function renderReport(envelope, { unlocked = false, healthScore = null, mode = 'web', links = {} } = {}) {
  const cards = envelope.findings
    .filter((f) => f.status !== 'dismissed' && f.status !== 'resolved')
    .map((f) => findingCard(f, unlocked)).join('\n');
  const degraded = envelope.degraded
    ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};background:${TOKENS.neutral100};border-radius:${TOKENS.radius};padding:10px 14px;margin-bottom:16px;">${fill(COPY.degraded_notice, { reasons: envelope.degraded_reasons.join(', ') })}</div>` : '';
  const unlockCta = !unlocked && links.unlock_url
    ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:8px auto 20px auto;"><tr><td style="background:${TOKENS.accent};border-radius:${TOKENS.radius};">
         <a href="${esc(links.unlock_url)}" style="display:inline-block;padding:12px 24px;font-family:${TOKENS.font};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${esc(COPY.unlock_cta)}</a>
       </td></tr></table>` : '';
  const cumulative = envelope.totals.ledger_cumulative.fixes > 0
    ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};text-align:center;padding:16px 0;border-top:1px solid ${TOKENS.neutral400};">${fill(COPY.cumulative_strip, { fixes: envelope.totals.ledger_cumulative.fixes, amount: '$' + envelope.totals.ledger_cumulative.waste_removed_usd.toLocaleString('en-US') })}</div>` : '';
  const sinceLast = envelope.narrative_slots.since_last_week
    ? `<div style="font-family:${TOKENS.font};padding:8px 0 16px 0;"><div style="font-size:14px;font-weight:600;color:${TOKENS.accent};">${esc(COPY.since_last_week_title)}</div><div style="font-size:14px;color:#333;">${esc(envelope.narrative_slots.since_last_week)}</div></div>` : '';
  const footerLinks = mode === 'email'
    ? `<div style="font-family:${TOKENS.font};font-size:12px;color:${TOKENS.neutral900};text-align:center;padding:16px 0;">
         ${links.web_url ? `<a href="${esc(links.web_url)}" style="color:${TOKENS.neutral900};">${esc(COPY.view_online)}</a> · ` : ''}${links.settings_url ? `<a href="${esc(links.settings_url)}" style="color:${TOKENS.neutral900};">${esc(COPY.settings_link)}</a>` : ''}
       </div>` : '';

  const body = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;"><tr><td style="padding:16px;">
    ${healthScore != null ? healthScoreBlock(healthScore) : ''}
    ${envelope.narrative_slots.exec_summary ? `<div style="font-family:${TOKENS.font};font-size:15px;color:#333;text-align:center;padding:0 8px 16px 8px;">${esc(envelope.narrative_slots.exec_summary)}</div>` : ''}
    ${moneyHeadline(envelope)}
    ${envelope.performance ? renderPerformanceSection(envelope.performance, TOKENS) : ''}
    ${degraded}
    ${unlockCta}
    ${cards}
    ${sinceLast}
    ${cumulative}
    <div style="font-family:${TOKENS.font};font-size:12px;color:${TOKENS.neutral900};text-align:center;padding-top:8px;">${esc(COPY.footer_note)}</div>
    ${footerLinks}
  </td></tr></table></td></tr></table>`;

  if (mode === 'email') {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#ffffff;">${body}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{margin:0;background:${TOKENS.neutral100};} .frame{background:#fff;max-width:640px;margin:24px auto;border:1px solid ${TOKENS.neutral400};border-radius:8px;overflow:hidden;}</style>
</head><body><div class="frame">${body}</div></body></html>`;
}

module.exports = { renderReport, TOKENS, fmtMoney };
