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
        stream: 'transactional', status: 'queued',
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
    connectionsForSweep: async () => db.select('google_connections', 'select=id,user_id,status,last_validated_at'),
  };
}

module.exports = { workerStore, webStore, executorStore, billingStore, opsStore };
