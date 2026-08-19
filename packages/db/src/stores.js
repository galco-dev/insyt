// Store adapters — the real Supabase implementations of every store contract
// the apps consume. One factory per consumer, all over one PostgREST client.
// Contracts are defined by the consumers (apps/worker/src/*, apps/web/src/*,
// packages/tools/src/executor.js, packages/billing/src/webhooks.js) — these
// adapters exist to satisfy them against the deployed §1 schema.

const q = (s) => encodeURIComponent(s);

// ---------------------------------------------------------------- worker
function workerStore(db) {
  return {
    saveCheckpoint: async (runId, checkpoint) => {
      await db.update('runs', `id=eq.${q(runId)}`, { checkpoint });
    },
    finishRun: async (runId, patch) => {
      await db.update('runs', `id=eq.${q(runId)}`, patch);
    },
    ruleConfig: async () => {
      const rows = await db.select('rule_config', 'select=*');
      return Object.fromEntries(rows.map((r) => [r.rule_id, r]));
    },
    priorFindings: async (tenantId) => db.select('findings',
      `select=rule_id,entity_key:payload->>entity_key,first_seen_run_id,status&tenant_id=eq.${q(tenantId)}&status=in.(open,approved,suspect)`),
    ledgerCumulative: async (tenantId) => db.select('ledger_cumulative', `tenant_id=eq.${q(tenantId)}`, { single: true }),
    saveFindings: async (runId, findings) => {
      if (!findings.length) return;
      await db.insert('findings', findings.map((f) => ({
        id: f.finding_id, run_id: runId, tenant_id: f.tenant_id, rule_id: f.rule_id,
        layer: f.layer, severity: f.severity, status: f.status,
        title: f.title, explanation: f.explanation,
        money_impact_monthly_usd: f.money ? f.money.impact_monthly_usd : null,
        money_impact_currency_local: f.money && f.money.impact_monthly_local ? f.money.impact_monthly_local : null,
        payload: { ...f.payload, entity_key: f.entity_key },
        fix_available: !!(f.fix && f.fix.available),
        first_seen_run_id: f.first_seen_run_id,
      })), { returning: false });
    },
    saveReport: async (runId, { html_email, html_web, findings_snapshot, tenant_id, type }) => {
      await db.insert('reports', [{
        run_id: runId, tenant_id, type: type || 'weekly',
        html_email, html_web, findings_snapshot: findings_snapshot || [],
      }], { returning: false });
    },
  };
}

// ---------------------------------------------------------------- web
function webStore(db) {
  return {
    createCrawlRow: async (row) => {
      const [r] = await db.insert('crawls', [{
        session_id: row.session_id || 'anon', url: row.url, status: 'running',
      }]);
      return r.id;
    },
    getCrawlRow: async (id) => db.select('crawls', `id=eq.${q(id)}&select=*`, { single: true }),
    patchCrawlRow: async (id, patch) => { await db.update('crawls', `id=eq.${q(id)}`, patch); },
    crawlCountForDomainSince: async (domain, sinceIso) => {
      const rows = await db.select('crawls', `url=ilike.*${q(domain)}*&created_at=gte.${q(sinceIso)}&select=id`);
      return rows.length;
    },
    getReportHtml: async (reportId) => db.select('reports',
      `id=eq.${q(reportId)}&select=html_web,unlocked`, { single: true }),
    magicLinks: {
      insertLink: async (row) => { await db.insert('magic_links', [row], { returning: false }); },
      findByHash: async (hash) => db.select('magic_links', `token_hash=eq.${q(hash)}&select=*`, { single: true }),
      markUsed: async (id, atIso) => { await db.update('magic_links', `id=eq.${q(id)}`, { used_at: atIso }); },
    },
  };
}

// ---------------------------------------------------------------- executor (write path)
function executorStore(db, { tenantId }) {
  return {
    // Idempotency rides on changes.idempotency_key (unique in schema).
    hasKey: async (key) => !!(await db.select('changes', `idempotency_key=eq.${q(key)}&select=id`, { single: true })),
    saveKey: async () => { /* key is persisted with the change row by the caller */ },
    ledger: async (entry) => { await db.insert('ledger', [{ tenant_id: tenantId, ...entry }], { returning: false }); },
    audit: async (entry) => { await db.insert('audit_log', [{ tenant_id: tenantId, ...entry }], { returning: false }); },
  };
}

// ---------------------------------------------------------------- billing (webhooks)
function billingStore(db) {
  return {
    upsertSubscription: async (row) => { await db.upsert('subscriptions', [row], 'stripe_subscription_id'); },
    markSubscription: async (stripeSubId, patch) => {
      await db.update('subscriptions', `stripe_subscription_id=eq.${q(stripeSubId)}`, patch);
    },
    recordPayment: async (row) => { await db.insert('payments', [row], { returning: false }); },
    ledger: async (entry) => { await db.insert('ledger', [entry], { returning: false }); },
    audit: async (entry) => { await db.insert('audit_log', [entry], { returning: false }); },
    scheduleEmail: async (templateId, tenantId, vars) => {
      await db.insert('emails', [{
        tenant_id: tenantId, template_id: templateId, to_email: vars.to_email || '',
        stream: 'transactional', status: 'queued', payload: vars || {},
      }], { returning: false });
    },
    tenantIdByCustomer: async (customerId) => {
      const row = await db.select('subscriptions', `stripe_customer_id=eq.${q(customerId)}&select=tenant_id&limit=1`, { single: true });
      return row ? row.tenant_id : null;
    },
  };
}

// ---------------------------------------------------------------- ops / scheduling
function opsStore(db) {
  return {
    tenants: async () => db.select('tenants', 'select=id,business_name,website_url,status,size_band,created_at&order=created_at.desc'),
    subscriptions: async () => db.select('subscriptions', 'select=tenant_id,tier,size_band,price_usd,status'),
    recentRuns: async (limit = 50) => db.select('runs', `select=id,tenant_id,type,status,started_at,finished_at,cogs_usd&order=started_at.desc.nullslast&limit=${limit}`),
    ledgerFor: async (tenantId, limit = 100) => db.select('ledger', `tenant_id=eq.${q(tenantId)}&select=*&order=created_at.desc&limit=${limit}`),
    cogsByTenant: async () => db.select('token_metering', 'select=tenant_id,cost_usd.sum()'),
    enqueueRun: async (row) => { const [r] = await db.insert('runs', [row]); return r; },
    activeTenants: async () => db.select('tenants', "select=id&status=eq.active"),
    dueWatches: async (nowIso) => db.select('watches', `status=eq.active&select=*&or=(last_check_at.is.null,last_check_at.lt.${q(nowIso)})`),
    patchWatch: async (id, patch) => { await db.update('watches', `id=eq.${q(id)}`, patch); },
    connectionsForSweep: async () => db.select('google_connections', 'select=id,user_id,status,last_validated_at'),
  };
}

// ---------------------------------------------------------------- dashboard (§11 screens)
// Consumed by apps/web server routes. healthScore comes from the rules
// package so the dial always matches the report's number.
function dashStore(db) {
  const { healthScore } = require('../../rules/src/engine');
  return {
    healthLatest: async (tenantId) => {
      const open = await db.select('findings', `tenant_id=eq.${q(tenantId)}&status=in.(open,approved,suspect)&select=severity,status`);
      return { score: healthScore(open), trend: [] };
    },
    pendingApprovals: async (tenantId) => {
      const rows = await db.select('changes',
        `tenant_id=eq.${q(tenantId)}&status=eq.proposed&select=id,finding:findings(title,money_impact_monthly_usd)&order=created_at.desc`);
      return rows.map((r) => ({
        id: r.id,
        title: (r.finding && r.finding.title) || 'A fix is ready',
        money_line: r.finding && r.finding.money_impact_monthly_usd
          ? `about $${Math.round(r.finding.money_impact_monthly_usd)} a month` : null,
      }));
    },
    cumulative: async (tenantId) => {
      const row = await db.select('ledger_cumulative', `tenant_id=eq.${q(tenantId)}`, { single: true });
      return row ? { fixes: row.fixes_applied, waste_removed_usd: Math.round(row.waste_removed_usd) } : null;
    },
    reports: async (tenantId) => db.select('reports', `tenant_id=eq.${q(tenantId)}&select=id,type,created_at,viewed_at&order=created_at.desc&limit=50`),
    ledger: async (tenantId) => db.select('ledger', `tenant_id=eq.${q(tenantId)}&select=*&order=created_at.desc&limit=100`),
    settings: async (tenantId) => {
      const [sub, auto, conn] = await Promise.all([
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,size_band,price_usd,status&limit=1`, { single: true }),
        db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }),
        db.select('google_connections', `select=status&limit=1`, { single: true }).catch(() => null),
      ]);
      return {
        plan_line: sub ? `${sub.tier[0].toUpperCase()}${sub.tier.slice(1)} · $${sub.price_usd}/mo (${sub.status})` : 'Free check — no plan yet',
        autopilot: (auto && auto.categories) || {},
        connection_status: conn && conn.status === 'valid' ? 'Google connection healthy.' : 'Google connection pending.',
      };
    },
    discovery: async (tenantId) => {
      const assets = await db.select('assets', `tenant_id=eq.${q(tenantId)}&select=id,kind,external_id,display_name,linked`);
      return { matched: assets.filter((a) => a.linked), unmatched: assets.filter((a) => !a.linked) };
    },
    confirmAssets: async (tenantId) => {
      await db.update('assets', `tenant_id=eq.${q(tenantId)}`, { linked: true });
    },
    planOptions: async (tenantId) => {
      const [pricing, tenant] = await Promise.all([
        db.select('pricing_config', 'select=matrix&order=effective_from.desc&limit=1', { single: true }),
        db.select('tenants', `id=eq.${q(tenantId)}&select=size_band`, { single: true }),
      ]);
      const band = (tenant && tenant.size_band) || '4k';
      const labels = { core: 'Core', autopilot: 'Autopilot', scale: 'Scale' };
      return {
        band,
        tiers: ['core', 'autopilot', 'scale'].map((tier) => ({
          tier, label: labels[tier], price_usd: pricing.matrix[tier][band], selected: tier === 'core',
        })),
      };
    },
    firstFix: async (tenantId) => {
      const change = await db.select('changes',
        `tenant_id=eq.${q(tenantId)}&status=eq.proposed&select=id,before,after,finding:findings(title,explanation)&order=created_at.asc&limit=1`, { single: true });
      if (!change) return null;
      return {
        change_id: change.id,
        finding_title: change.finding ? change.finding.title : 'Your first fix',
        explanation: change.finding ? change.finding.explanation : '',
        before_line: change.before ? JSON.stringify(change.before).slice(0, 120) : 'current setup',
        after_line: change.after ? JSON.stringify(change.after).slice(0, 120) : 'proposed setup',
      };
    },
    journey: async (tenantId) => {
      const j = await db.select('journey_state', `tenant_id=eq.${q(tenantId)}&select=journey,stage,gates&limit=1`, { single: true });
      if (!j) return { journey: 'A', stage: 'active', gates: { tag: true, billing: true, approval: true }, instruction_line: 'Everything is set up — your weekly checks run automatically.' };
      const next = !j.gates.tag ? 'Install your tracking — the guide takes 30 seconds.'
        : !j.gates.approval ? 'Review and approve your campaigns.'
          : !j.gates.billing ? 'Connect your ad money to Google — last step.' : 'All gates clear — launching.';
      return { ...j, instruction_line: next };
    },
    approveChange: async (tenantId, changeId) => {
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}`, { status: 'approved' });
      await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: changeId, channel: 'dashboard' }], { returning: false });
    },
    dismissChange: async (tenantId, changeId) => {
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}`, { status: 'failed' });
      const ch = await db.select('changes', `id=eq.${q(changeId)}&select=finding_id`, { single: true });
      if (ch) await db.update('findings', `id=eq.${q(ch.finding_id)}`, { status: 'dismissed' });
    },
    requestRevert: async (tenantId, changeId) => {
      await db.insert('audit_log', [{ tenant_id: tenantId, event: 'revert_requested', detail: { change_id: changeId } }], { returning: false });
    },
  };
}

module.exports = { workerStore, webStore, executorStore, billingStore, opsStore, dashStore };
