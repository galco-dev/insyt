// The assistant's read-only tool surface — engine-spec §7.1 "Ask" / §7.4
// rule 4. Structural guardrail: this module contains NO execute, NO
// cross-tenant read, NO billing mutation. Every payload carries an as_of so
// the model quotes numbers with their time and never recomputes them.

const q = (s) => encodeURIComponent(s);
const nowIso = () => new Date().toISOString();

function createReadTools({ db, dashStore = null }) {
  return {
    spend: async (tenantId) => {
      const s = dashStore && dashStore.spendPosition ? await dashStore.spendPosition(tenantId).catch(() => null) : null;
      return { as_of: s && s.as_of ? s.as_of : nowIso(), month_to_date_usd: s ? s.month_usd : null, month_budget_usd: s ? s.month_budget_usd : null, pace_line: s ? s.pace_line : 'No spend snapshot yet - it arrives with the first weekly check.' };
    },
    approvals: async (tenantId) => {
      const rows = await db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.proposed&select=id,summary_text,money_impact_usd,ask_reason,created_at&order=created_at.desc&limit=10`).catch(() => []);
      return { as_of: nowIso(), pending: (rows || []).map((r) => ({ id: r.id, what: r.summary_text, about_usd_per_month: r.money_impact_usd, why_asking: r.ask_reason, since: r.created_at })) };
    },
    history: async (tenantId, limit = 12) => {
      const rows = await db.select('ledger', `tenant_id=eq.${q(tenantId)}&select=event,actor,summary_text,money_impact_usd,created_at&order=created_at.desc&limit=${limit}`).catch(() => []);
      return { as_of: nowIso(), entries: (rows || []).map((r) => ({ when: r.created_at, who: r.actor, what: r.summary_text, event: r.event })) };
    },
    findings: async (tenantId) => {
      const rows = await db.select('findings', `tenant_id=eq.${q(tenantId)}&status=in.(open,approved,suspect)&select=rule_id,severity,title,explanation,money_impact_monthly_usd,first_seen_at&order=severity.asc&limit=15`).catch(() => []);
      return { as_of: nowIso(), open: (rows || []).map((r) => ({ severity: r.severity, title: r.title, explanation: r.explanation, about_usd_per_month: r.money_impact_monthly_usd, open_since: r.first_seen_at })) };
    },
    watches: async (tenantId) => {
      const rows = await db.select('watches', `tenant_id=eq.${q(tenantId)}&kind=eq.change_verify&select=status,outcome,effect,schedule,closed_at,baseline&order=created_at.desc&limit=8`).catch(() => []);
      return { as_of: nowIso(), checks: (rows || []).map((w) => ({ status: w.status, outcome: w.outcome, closed_at: w.closed_at, days: w.schedule && w.schedule.days, effect: w.effect, change: w.baseline && w.baseline.tool_id })) };
    },
    autopilot: async (tenantId) => {
      const a = await db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }).catch(() => null);
      const c = (a && a.categories) || {};
      const on = (k) => c[k] === true || c[k] === 'auto';
      return { as_of: nowIso(), negatives: on('negatives'), budgets: on('budgets'), counting: on('counting') };
    },
    exceptions: async (tenantId) => {
      const rows = await db.select('standing_exceptions', `tenant_id=eq.${q(tenantId)}&cleared_at=is.null&select=summary_text,created_at&order=created_at.desc`).catch(() => []);
      return { as_of: nowIso(), never_touch: (rows || []).map((r) => r.summary_text) };
    },
    campaigns: async (tenantId) => {
      const rows = await db.select('campaigns', `tenant_id=eq.${q(tenantId)}&select=google_campaign_id,name,status,budget_daily_usd,bidding,last_seen_at&order=name.asc&limit=50`).catch(() => []);
      return { as_of: (rows && rows[0] && rows[0].last_seen_at) || nowIso(), campaigns: (rows || []).map((c) => ({ id: c.google_campaign_id, name: c.name, status: c.status, budget_daily_usd: c.budget_daily_usd != null ? Number(c.budget_daily_usd) : null, bidding: c.bidding })) };
    },
    drafts: async (tenantId) => {
      const rows = await db.select('campaign_drafts', `tenant_id=eq.${q(tenantId)}&status=neq.dismissed&select=id,status,spec&order=created_at.desc&limit=5`).catch(() => []);
      return { as_of: nowIso(), your_ads: (rows || []).map((d) => ({ id: d.id, name: d.spec && d.spec.name, status: d.status, budget_daily_usd: d.spec && d.spec.budget_daily_usd })) };
    },
  };
}

// Cheap keyword routing: which tool payloads a question needs. The model
// never chooses tools; code does, and passes data in.
function routeQuestion(text) {
  const t = String(text || '').toLowerCase();
  const picks = new Set();
  if (/spend|spent|budget|pace|cost|money|paying|bill/.test(t)) picks.add('spend').add('campaigns');
  if (/approv|pending|waiting|card|suggest/.test(t)) picks.add('approvals');
  if (/history|did you|have you|last week|what changed|applied|undo|revert/.test(t)) picks.add('history').add('watches');
  if (/finding|issue|problem|wrong|fix|report|health|tracking|counting/.test(t)) picks.add('findings');
  if (/autopilot|automatic|on its own|without asking/.test(t)) picks.add('autopilot').add('exceptions');
  if (/never|exception|touch/.test(t)) picks.add('exceptions');
  if (/campaign|ad\b|ads\b|running|paused|live/.test(t)) picks.add('campaigns').add('drafts');
  if (/work|verified|result|effect|better|worse/.test(t)) picks.add('watches');
  if (!picks.size) ['spend', 'approvals', 'findings', 'campaigns'].forEach((p) => picks.add(p));
  return [...picks];
}

module.exports = { createReadTools, routeQuestion };
