// Authed dashboard screens — build-doc §11 screens 2, 5–12, server-rendered
// on the §18 tokens. Every screen: one clear action; empty states sell the
// next step, never a blank. The React/shadcn port replaces these renderers;
// the routes and dashStore contract stay.
//
// dashStore contract (implemented over packages/db stores):
//   tenant(tenantId), healthLatest(tenantId) -> {score, trend:[..]}
//   pendingApprovals(tenantId) -> [{id, title, money_line, finding_id}]
//   approveChange(tenantId, changeId), dismissChange(tenantId, changeId)
//   ledger(tenantId), reports(tenantId) -> [{id, type, created_at, viewed_at}]
//   settings(tenantId) -> { plan_line, autopilot, connection_status, email }
//   setAutopilot(tenantId, categories)
//   discovery(tenantId) -> { matched:[], unmatched:[] }   (§7 confirm screen)
//   confirmAssets(tenantId, ids)
//   planOptions(tenantId) -> { band, tiers:[{tier,label,price_usd,selected}] }
//   journey(tenantId) -> { journey, stage, gates, instruction_line }
//   firstFix(tenantId) -> { finding_title, explanation, before_line, after_line, change_id } | null

const FONT = "'Geist', Helvetica, Arial, sans-serif";
const ACCENT = '#000d14';
const COLORS = { critical: '#DC2626', warning: '#D97706', success: '#16A34A', info: '#2563EB' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, active, body) {
  const tabs = [
    ['/app', 'Home'], ['/app/approvals', 'Approvals'], ['/app/ledger', 'History'],
    ['/app/reports', 'Reports'], ['/app/settings', 'Settings'],
  ].map(([href, label]) => `<a href="${href}" style="padding:8px 12px;text-decoration:none;color:${href === active ? ACCENT : '#727272'};font-weight:${href === active ? 600 : 400};">${label}</a>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{margin:0;font-family:${FONT};background:#f7f7f7;color:${ACCENT};}
.bar{background:#fff;border-bottom:1px solid #e6e6e6;padding:8px 12px;display:flex;overflow-x:auto;}
.wrap{max-width:640px;margin:16px auto;padding:0 12px;}
.card{background:#fff;border:1px solid #e6e6e6;border-radius:6px;padding:16px;margin-bottom:12px;}
button{font-family:${FONT};font-size:14px;font-weight:500;background:${ACCENT};color:#fff;border:0;border-radius:6px;padding:10px 20px;cursor:pointer;}
button.ghost{background:#fff;color:${ACCENT};border:1px solid #d1d1d1;}
.sub{color:#727272;font-size:13px;}</style></head>
<body><div class="bar">${tabs}</div><div class="wrap">${body}</div></body></html>`;
}

const empty = (line, ctaLabel, ctaHref) => `<div class="card" style="text-align:center;">
  <p>${esc(line)}</p>${ctaHref ? `<a href="${ctaHref}"><button>${esc(ctaLabel)}</button></a>` : ''}</div>`;

// ---- screen 7: dashboard home
function homeScreen({ health, pending, cumulative, latestReportId }) {
  const color = health.score >= 80 ? COLORS.success : health.score >= 50 ? COLORS.warning : COLORS.critical;
  return shell('Insyt', '/app', `
  <div class="card" style="text-align:center;">
    <div style="font-size:48px;font-weight:600;color:${color};">${health.score}</div>
    <div class="sub">Account health</div>
  </div>
  ${pending.length
    ? `<div class="card"><b>${pending.length} fix${pending.length === 1 ? '' : 'es'} waiting for your approval</b>
       <p class="sub">${esc(pending[0].title)}${pending.length > 1 ? ` and ${pending.length - 1} more` : ''}</p>
       <a href="/app/approvals"><button>Review and approve</button></a></div>`
    : empty('Nothing needs you right now — the next check runs Sunday night.', latestReportId ? 'Read the latest report' : null, latestReportId ? `/r/${latestReportId}` : null)}
  ${cumulative && cumulative.fixes ? `<p class="sub" style="text-align:center;">${cumulative.fixes} fixes applied since day one · about $${cumulative.waste_removed_usd} of waste removed</p>` : ''}`);
}

// ---- screen 8: approvals queue
function approvalsScreen({ pending }) {
  const cards = pending.map((p) => `<div class="card">
    <b>${esc(p.title)}</b>
    ${p.money_line ? `<p class="sub">${esc(p.money_line)}</p>` : ''}
    <form method="post" action="/app/approve/${esc(p.id)}" style="display:inline"><button>Approve</button></form>
    <form method="post" action="/app/dismiss/${esc(p.id)}" style="display:inline;margin-left:8px;"><button class="ghost">Not this one</button></form>
  </div>`).join('');
  return shell('Approvals', '/app/approvals',
    pending.length ? cards : empty('All caught up — approvals from your weekly email land here too.', null, null));
}

// ---- screen 9: change ledger
function ledgerScreen({ entries }) {
  const rows = entries.map((l) => `<div class="card">
    <b>${esc(l.summary_text)}</b>
    <p class="sub">${esc((l.created_at || '').slice(0, 10))}${l.money_impact_usd ? ` · $${esc(l.money_impact_usd)}` : ''}${l.event === 'fix_applied' && l.change_id ? ` · <a href="/app/revert/${esc(l.change_id)}">undo</a>` : ''}</p>
  </div>`).join('');
  return shell('History', '/app/ledger',
    entries.length ? rows : empty('Every fix we apply shows up here, with a one-tap undo.', null, null));
}

// ---- screen 10: report archive
function reportsScreen({ reports }) {
  const rows = reports.map((r) => `<div class="card"><a href="/r/${esc(r.id)}" style="color:${ACCENT};text-decoration:none;">
    <b>${esc(r.type)} report</b> <span class="sub">· ${esc((r.created_at || '').slice(0, 10))}${r.viewed_at ? '' : ' · new'}</span></a></div>`).join('');
  return shell('Reports', '/app/reports',
    reports.length ? rows : empty('Your first report appears here minutes after you connect.', null, null));
}

// ---- screen 12: settings
function settingsScreen({ settings }) {
  const cats = Object.entries(settings.autopilot || {}).map(([cat, mode]) => `<label style="display:block;padding:6px 0;">
    <input type="checkbox" name="${esc(cat)}" ${mode === 'auto' ? 'checked' : ''}> ${esc(cat.replace(/_/g, ' '))} — apply automatically</label>`).join('');
  return shell('Settings', '/app/settings', `
  <div class="card"><b>Plan</b><p class="sub">${esc(settings.plan_line)}</p><a href="${esc(settings.portal_url || '#')}"><button class="ghost">Manage billing</button></a></div>
  <div class="card"><b>Automation</b><form method="post" action="/app/settings/autopilot">${cats}<button style="margin-top:8px;">Save</button></form></div>
  <div class="card"><b>Google connection</b><p class="sub">${esc(settings.connection_status)}</p></div>`);
}

// ---- screen 2: discovery confirm (§7 — one button, never a form)
function discoveryScreen({ matched, unmatched }) {
  const cards = matched.map((a) => `<div class="card" style="border-left:4px solid ${COLORS.success};">
    <b>${esc(a.display_name || a.external_id)}</b> <span class="sub">· found on your site</span></div>`).join('');
  const rest = unmatched.length ? `<details class="sub" style="margin:8px 0;"><summary>${unmatched.length} other account item(s) we can see</summary>
    ${unmatched.map((a) => `<p class="sub">${esc(a.display_name || a.external_id)}</p>`).join('')}</details>` : '';
  return shell('Is this yours?', '/app', `
  <h2 style="text-align:center;">We found your setup</h2>
  ${cards}${rest}
  <form method="post" action="/app/confirm" style="text-align:center;"><button>Yes — run my free check</button></form>`);
}

// ---- screen 5: plan (one column — their band; Core pre-selected)
function planScreen({ plan }) {
  const rows = plan.tiers.map((t) => `<label class="card" style="display:block;border:2px solid ${t.selected ? ACCENT : '#e6e6e6'};">
    <input type="radio" name="tier" value="${esc(t.tier)}" ${t.selected ? 'checked' : ''}> <b>${esc(t.label)}</b>
    <span style="float:right;font-weight:600;">$${esc(t.price_usd)}/mo</span></label>`).join('');
  return shell('Pick your plan', '/app', `
  <form method="post" action="/app/subscribe">${rows}
  <p class="sub" style="text-align:center;">Your $20 audit payment is credited to the first month.</p>
  <div style="text-align:center;"><button>Start — cancel anytime</button></div></form>`);
}

// ---- screen 6: first-fix ceremony
function firstFixScreen({ fix }) {
  if (!fix) return shell('First fix', '/app', empty('No fix is waiting — your report has the full picture.', 'Back home', '/app'));
  return shell('Your first fix', '/app', `
  <div class="card"><b>${esc(fix.finding_title)}</b><p>${esc(fix.explanation)}</p>
  <p class="sub">Before: ${esc(fix.before_line)}<br>After: ${esc(fix.after_line)}</p></div>
  <p class="sub" style="text-align:center;">To apply fixes we need permission to make changes — Google will ask once. We verify every change within 48 hours and anything can be undone with one tap.</p>
  <form method="post" action="/app/approve/${esc(fix.change_id)}" style="text-align:center;"><button>Approve this fix</button></form>`);
}

// ---- screen 11: journey progress
function journeyScreen({ journey }) {
  const gate = (label, ok) => `<p>${ok ? '✅' : '◻️'} ${esc(label)}</p>`;
  return shell('Your setup', '/app', `
  <div class="card">${gate('Tracking installed on your site', journey.gates.tag)}${gate('Google billing connected', journey.gates.billing)}${gate('Campaigns approved', journey.gates.approval)}</div>
  <div class="card"><b>Next step</b><p>${esc(journey.instruction_line)}</p></div>`);
}

module.exports = {
  homeScreen, approvalsScreen, ledgerScreen, reportsScreen, settingsScreen,
  discoveryScreen, planScreen, firstFixScreen, journeyScreen, shell,
};
