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

// v28 light mono palette (21 Aug 2026): ink/silver chrome, severity colors
// are the only hues. The app's dark theme is a client concern; this renderer
// serves email + standalone web where light is the correct ground.
const TOKENS = {
  accent: '#16181b',
  cta: '#2563EB', // brand blue — primary action only (kit v2, Sep 2026)
  critical: '#DC2626',
  warning: '#D97706',
  success: '#16A34A',
  info: '#2563EB',
  opportunity: '#16A34A',
  neutral100: '#f6f6f7',
  neutral400: '#e4e5e7',
  neutral900: '#565b63',
  radius: '6px',
  font: "'Geist', Helvetica, Arial, sans-serif",
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => esc(vars[k] ?? ''));

function fmtMoney(usd, local, currency) {
  if (local && local.amount != null && local.currency) {
    return `${esc(local.currency)} ${Math.round(local.amount).toLocaleString('en-US')}`;
  }
  const cur = currency || '$';
  return `${cur}${Math.round(usd || 0).toLocaleString('en-US')}`;
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
        <td style="font-family:${TOKENS.font};font-size:13px;padding:4px 8px;border-bottom:1px solid ${TOKENS.neutral400};color:${TOKENS.neutral900};text-align:right;">${e.spend_usd != null ? ((finding.money && finding.money.currency && finding.money.currency !== 'USD' ? finding.money.currency + ' ' : '$')) + Math.round(e.spend_usd).toLocaleString('en-US') : ''}</td>
      </tr>`).join('');
    const fixLine = p.fix_detail ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.accent};padding:8px;">${esc(p.fix_detail)}</div>` : '';
    return `${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : ''}${fixLine}`;
  }
  const count = (p.entities || []).length;
  if (count === 0) return `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};padding:8px;">${esc(COPY.locked_fix_placeholder)}</div>`;
  const kind = (p.entities[0] && p.entities[0].kind) || 'default';
  const nouns = count === 1 && COPY.noun_for_kind_singular ? COPY.noun_for_kind_singular : COPY.noun_for_kind;
  const noun = nouns[kind] || nouns.default;
  return `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};background:${TOKENS.neutral100};border:1px dashed ${TOKENS.neutral400};border-radius:${TOKENS.radius};padding:12px;text-align:center;">${fill(COPY.locked_placeholder, { count, noun })}</div>`;
}

function findingCard(finding, unlocked) {
  const color = sevColor(finding.severity);
  const money = finding.money && finding.money.impact_monthly_usd > 0
    ? `<span style="float:right;font-weight:600;color:${finding.money.direction === 'opportunity' ? TOKENS.success : color};">${finding.money.confidence === 'estimated' ? '~' : ''}${fmtMoney(finding.money.impact_monthly_usd, finding.money.impact_monthly_local || (finding.money.currency && finding.money.currency !== 'USD' ? { amount: finding.money.impact_monthly_usd, currency: finding.money.currency } : null))}/mo</span>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;border:1px solid ${TOKENS.neutral400};border-left:4px solid ${color};border-radius:${TOKENS.radius};">
    <tr><td style="padding:12px 16px;">
      <div style="font-family:${TOKENS.font};font-size:11px;font-weight:500;color:${color};text-transform:uppercase;letter-spacing:.04em;">${esc(COPY.severity_labels[finding.severity] || finding.severity)}${finding.is_new === false && finding.still_open_days >= 7 ? `<span style="font-weight:400;color:${TOKENS.neutral900};text-transform:none;letter-spacing:0;"> · still open, ${finding.still_open_days} days</span>` : ''}</div>
      <div style="font-family:${TOKENS.font};font-size:16px;font-weight:600;color:${TOKENS.accent};padding:4px 0;">${esc(finding.title || '')}${money}</div>
      <div style="font-family:${TOKENS.font};font-size:14px;color:#333;padding-bottom:8px;">${esc(finding.explanation || '')}</div>
      ${payloadBlock(finding, unlocked)}
    </td></tr></table>`;
}

const { renderPerformanceSection } = require('./performance');
const charts = require('./charts');

/* ------------------------------------------------------- deep sections */
const DEEP = COPY.deep || {};
const th = (t, align = 'left') => `<th style="font-family:${TOKENS.font};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#ffffff;background:${TOKENS.accent};padding:7px 9px;text-align:${align};">${esc(t)}</th>`;
const td = (v, { align = 'left', color = '#333', weight = 400 } = {}) => `<td style="font-family:${TOKENS.font};font-size:12.5px;color:${color};padding:6px 9px;border-bottom:1px solid ${TOKENS.neutral400};text-align:${align};font-weight:${weight};font-variant-numeric:tabular-nums;">${v}</td>`;
const statusChip = (status) => {
  const map = { good: TOKENS.success, watch: TOKENS.warning, serious: TOKENS.critical };
  const color = map[status] || TOKENS.neutral900;
  const label = (DEEP.status_labels || {})[status] || status;
  return `<span style="font-family:${TOKENS.font};display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${color};"><span style="display:inline-block;width:6px;height:6px;border-radius:99px;background:${color};box-shadow:0 0 0 2.5px ${color}22;"></span>${esc(label)}</span>`;
};
const modelledChip = () => `<span style="font-family:${TOKENS.font};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:${TOKENS.neutral900};border:1px solid ${TOKENS.neutral400};border-radius:99px;padding:1.5px 7px;margin-left:8px;vertical-align:middle;">${esc(DEEP.modelled_label || 'modelled')}</span>`;

function deepSection(title, sub, inner, { modelled = false } = {}) {
  return `<div style="padding:20px 0 6px 0;">
    <div style="font-family:${TOKENS.font};font-size:17px;font-weight:600;color:${TOKENS.accent};">${esc(title)}${modelled ? modelledChip() : ''}</div>
    ${sub ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};padding:3px 0 10px 0;">${esc(sub)}</div>` : ''}
    ${inner}
  </div>`;
}

function lockedTableNote(count) {
  return `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};background:${TOKENS.neutral100};border:1px dashed ${TOKENS.neutral400};border-radius:${TOKENS.radius};padding:12px;text-align:center;">${fill(DEEP.locked_table || '{count} rows in the full report', { count })}</div>`;
}

function renderDeepSections(deep, { unlocked, mode, currency }) {
  if (!deep) return '';
  if (mode === 'email') {
    return `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};background:${TOKENS.neutral100};border-radius:${TOKENS.radius};padding:12px 14px;margin:8px 0 16px 0;text-align:center;">${esc(DEEP.email_deep_strip || '')}</div>`;
  }
  const cur = currency || '$';
  let out = '';
  if (deep.money_picture) {
    const mp = deep.money_picture;
    out += deepSection(DEEP.money_picture_title, DEEP.money_picture_sub, charts.lineChart({
      xLabels: mp.x_labels,
      series: [
        { label: 'Actual spend', points: mp.actual },
        { label: 'With waste removed', points: mp.optimized, status: 'success' },
      ],
      band: { from: 1, to: 0, labels: mp.saved.map((v) => (v > 0 ? `-${v.toLocaleString('en-US')}` : null)) },
    }), { modelled: mp.modelled });
  }
  if (deep.cpa_curve) {
    const cc = deep.cpa_curve;
    const regIdx = cc.regression_period ? cc.x_labels.indexOf(cc.regression_period) : -1;
    out += deepSection(DEEP.cpa_curve_title, DEEP.cpa_curve_sub, charts.lineChart({
      xLabels: cc.x_labels,
      series: [{ label: 'Cost per result', points: cc.values }],
      annotate: regIdx > 0 ? [{ i0: regIdx - 0.5 >= 0 ? regIdx - 0.5 : 0, i1: regIdx, label: 'off the floor' }] : [],
    }));
  }
  if (deep.leak_ledger) {
    const l = deep.leak_ledger; const t = l.totals;
    const bars = charts.stackedBarsH({ rows: [{ label: 'Account', segments: [
      { label: 'Recovered', value: t.recovered_usd, kind: 'recovered' },
      { label: 'Calendar waste', value: t.calendar_usd, kind: 'calendar' },
      { label: 'Still bleeding', value: t.active_usd, kind: 'active' },
    ].filter((g) => g.value > 0) }], unit: '' });
    const rows = l.rows.map((r) => `<tr>${td(esc(r.label))}${td(`${cur}${r.cost_usd.toLocaleString('en-US')}/mo${r.modelled ? modelledChip() : ''}`, { align: 'right' })}${td(statusChip(r.severity === 'critical' ? 'serious' : r.severity === 'warning' ? 'watch' : 'good'))}${td(esc(r.fix))}</tr>`).join('');
    out += deepSection(DEEP.leaks_title, DEEP.leaks_sub, `${bars}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-collapse:collapse;"><tr>${th('Leak')}${th('Cost', 'right')}${th('Status')}${th('Fix')}</tr>${rows}</table>`);
  }
  if (deep.qs_distribution) {
    const q = deep.qs_distribution;
    out += deepSection(DEEP.qs_title, DEEP.qs_sub,
      charts.histogram({ bins: q.bins, note: `average ${q.avg}` })
      + `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};padding-top:6px;">${esc(DEEP.modelled_note || '')}</div>`,
      { modelled: true });
  }
  if (deep.hour_profile) {
    out += deepSection(DEEP.hours_title, DEEP.hours_sub, charts.hourProfile({ hours: deep.hour_profile.hours, flagged: deep.hour_profile.flagged, currency: cur }));
  }
  if (deep.headroom) {
    out += deepSection(DEEP.headroom_title, DEEP.headroom_sub, charts.shareBars({ rows: deep.headroom.rows.map((r) => ({ label: r.label, pct: r.pct })) }));
  }
  if (deep.keyword_table) {
    const inner = unlocked
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${th('Search')}${th('Match')}${th('Cost', 'right')}${th('Clicks', 'right')}${th('Results', 'right')}${th('Cost/result', 'right')}${th('Quality', 'right')}${th('Status')}</tr>
        ${deep.keyword_table.rows.map((k) => `<tr>${td(esc(k.keyword), { weight: 600, color: TOKENS.accent })}${td(esc(k.match))}${td(cur + k.cost_usd.toLocaleString('en-US'), { align: 'right' })}${td(k.clicks, { align: 'right' })}${td(k.conversions, { align: 'right' })}${td(k.cpa_usd != null ? cur + k.cpa_usd.toLocaleString('en-US') : '-', { align: 'right' })}${td(k.quality ?? '-', { align: 'right' })}${td(statusChip(k.status))}</tr>`).join('')}</table>`
      : lockedTableNote(deep.keyword_table.rows.length);
    out += deepSection(DEEP.keywords_title, null, inner);
  }
  if (deep.conversion_mix) {
    out += deepSection(DEEP.conversion_mix_title, null,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${th('Signal')}${th('Count', 'right')}${th('Share', 'right')}${th('Note')}</tr>
      ${deep.conversion_mix.map((r) => `<tr>${td(esc(r.signal), { weight: 600, color: TOKENS.accent })}${td(r.count, { align: 'right' })}${td(r.share_pct + '%', { align: 'right' })}${td(esc(r.note))}</tr>`).join('')}</table>`);
  }
  if (deep.copy_assets) {
    const inner = unlocked
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${th('Wording')}${th('Type')}${th('Views', 'right')}${th('Status')}${th('Insight')}</tr>
        ${deep.copy_assets.rows.map((a) => `<tr>${td(esc(a.text), { weight: 600, color: TOKENS.accent })}${td(esc(a.type))}${td(a.impressions != null ? a.impressions.toLocaleString('en-US') : '-', { align: 'right' })}${td(statusChip(a.status))}${td(esc(a.insight))}</tr>`).join('')}</table>`
      : lockedTableNote(deep.copy_assets.rows.length);
    out += deepSection(DEEP.copy_title, null, inner);
  }
  if (deep.execution_register) {
    const inner = unlocked
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${th('ID')}${th('Change')}${th('Exact item')}${th('Why')}${th('Status')}</tr>
        ${deep.execution_register.rows.map((c) => `<tr>${td(esc(c.id))}${td(esc(c.kind))}${td(esc(c.item), { weight: 600, color: TOKENS.accent })}${td(esc(c.rationale))}${td(esc(c.status) + (c.verified_at ? ` · ${esc(c.verified_at)}` : ''), { color: TOKENS.success, weight: 600 })}</tr>`).join('')}</table>`
      : lockedTableNote(deep.execution_register.rows.length);
    out += deepSection(DEEP.register_title, DEEP.register_sub, inner);
  }
  if (deep.unexamined && deep.unexamined.length) {
    out += deepSection(DEEP.unexamined_title, DEEP.unexamined_sub,
      deep.unexamined.map((u) => `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};border:1px solid ${TOKENS.neutral400};border-radius:${TOKENS.radius};padding:9px 12px;margin-bottom:6px;">${esc(u)}</div>`).join(''));
  }
  return out;
}

function renderReport(envelope, { unlocked = false, healthScore = null, mode = 'web', links = {} } = {}) {
  const cards = envelope.findings
    .filter((f) => f.status !== 'dismissed' && f.status !== 'resolved')
    .map((f) => findingCard(f, unlocked)).join('\n');
  const degraded = envelope.degraded
    ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};background:${TOKENS.neutral100};border-radius:${TOKENS.radius};padding:10px 14px;margin-bottom:16px;">${fill(COPY.degraded_notice, { reasons: envelope.degraded_reasons.join(', ') })}</div>` : '';
  const unlockCta = !unlocked && links.unlock_url
    ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:8px auto 20px auto;"><tr><td style="background:${TOKENS.cta};border-radius:${TOKENS.radius};">
         <a href="${esc(links.unlock_url)}" style="display:inline-block;padding:12px 24px;font-family:${TOKENS.font};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${esc(COPY.unlock_cta)}</a>
       </td></tr></table>` : '';
  const cumulative = envelope.totals.ledger_cumulative.fixes > 0
    ? `<div style="font-family:${TOKENS.font};font-size:13px;color:${TOKENS.neutral900};text-align:center;padding:16px 0;border-top:1px solid ${TOKENS.neutral400};">${fill(COPY.cumulative_strip, { fixes: envelope.totals.ledger_cumulative.fixes, amount: (envelope.currency_symbol || '$') + envelope.totals.ledger_cumulative.waste_removed_usd.toLocaleString('en-US') })}</div>` : '';
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
    ${renderDeepSections(envelope.deep, { unlocked, mode, currency: envelope.currency_symbol })}
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
