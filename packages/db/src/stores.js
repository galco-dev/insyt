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
      const [open, past] = await Promise.all([
        db.select('findings', `tenant_id=eq.${q(tenantId)}&status=in.(open,approved,suspect)&select=severity,status`),
        db.select('reports', `tenant_id=eq.${q(tenantId)}&select=created_at,findings_snapshot&order=created_at.desc&limit=8`).catch(() => []),
      ]);
      // Trend = health recomputed from each report's frozen snapshot, oldest first,
      // so the sparkline always agrees with the numbers those reports showed.
      const trend = (past || []).slice().reverse()
        .map((r) => ({ at: r.created_at, score: healthScore(r.findings_snapshot || []) }));
      return { score: healthScore(open), trend };
    },
    // Leading run of yes-answers (approved/applied) in the most recent changes,
    // broken by a dismissal. Feeds the Autopilot graduation prompt (§12).
    approvalStreak: async (tenantId) => {
      const rows = await db.select('changes',
        `tenant_id=eq.${q(tenantId)}&status=in.(approved,applied,failed)&select=status&order=created_at.desc&limit=25`).catch(() => []);
      let streak = 0;
      for (const r of rows || []) {
        if (r.status === 'approved' || r.status === 'applied') streak += 1;
        else break;
      }
      return streak;
    },
    // Standing plan/size-band position for the dashboard header (§5 "standing state").
    planPosition: async (tenantId) => {
      const [sub, tenant] = await Promise.all([
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,status&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=size_band`, { single: true }).catch(() => null),
      ]);
      const labels = { core: 'Core', autopilot: 'Autopilot', scale: 'Scale' };
      return {
        tier: sub ? sub.tier : null,
        label: sub ? (labels[sub.tier] || sub.tier) : 'Free check',
        band: (tenant && tenant.size_band) || '4k',
      };
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
    reportData: async (tenantId, reportId) => {
      const r = await db.select('reports',
        `id=eq.${q(reportId)}&tenant_id=eq.${q(tenantId)}&select=id,type,created_at,findings_snapshot,unlocked`, { single: true });
      if (r) await db.update('reports', `id=eq.${q(reportId)}`, { viewed_at: new Date().toISOString() }).catch(() => {});
      return r;
    },
    ledger: async (tenantId) => db.select('ledger', `tenant_id=eq.${q(tenantId)}&select=*&order=created_at.desc&limit=100`),
    settings: async (tenantId) => {
      const [sub, auto, conn] = await Promise.all([
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,size_band,price_usd,status&limit=1`, { single: true }),
        db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }),
        db.select('google_connections', `select=status&user_id=in.(select id from users)&limit=1`, { single: true }).catch(() => null),
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

// ---------------------------------------------------------------- agency (master §13)
// Binding: no auto-apply, no auto-publish. Every mutation logs to
// agency_audit_log with the acting seat — the agency's own dispute record.
function agencyStore(db) {
  const { healthScore } = require('../../rules/src/engine');
  const log = async (agencyId, seatId, event, detail) => {
    await db.insert('agency_audit_log', [{ agency_id: agencyId, seat_id: seatId, event, detail: detail || {} }], { returning: false }).catch(() => {});
  };
  return {
    // Resolve the acting seat from the platform session's tenant id.
    seatByTenant: async (tenantId) => db.select('agency_seats',
      `tenant_id=eq.${q(tenantId)}&status=eq.active&select=id,agency_id,role,name,email&limit=1`, { single: true }),
    agency: async (agencyId) => db.select('agencies', `id=eq.${q(agencyId)}&select=*`, { single: true }),

    // Portfolio grid: every managed account with health, pending count and
    // last-report age, computed from one query per table (no N+1).
    portfolio: async (agencyId) => {
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=eq.active&select=id,tenant_id,display_name,brief_only,report_register,seat:agency_seats(name)`);
      if (!accounts.length) return [];
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const [findings, changes, reports] = await Promise.all([
        db.select('findings', `tenant_id=in.(${ids})&status=in.(open,approved,suspect)&select=tenant_id,severity,status`),
        db.select('changes', `tenant_id=in.(${ids})&status=eq.proposed&select=tenant_id`),
        db.select('reports', `tenant_id=in.(${ids})&select=tenant_id,created_at,review_status&order=created_at.desc&limit=500`),
      ]);
      const by = (rows) => rows.reduce((m, r) => ((m[r.tenant_id] = m[r.tenant_id] || []).push(r), m), {});
      const f = by(findings); const c = by(changes); const r = by(reports);
      return accounts.map((a) => {
        const own = f[a.tenant_id] || [];
        const latest = (r[a.tenant_id] || [])[0];
        return {
          id: a.id,
          tenant_id: a.tenant_id,
          name: a.display_name,
          manager: a.seat ? a.seat.name : null,
          brief_only: a.brief_only,
          register: a.report_register,
          health: healthScore(own),
          open_findings: own.length,
          critical: own.filter((x) => x.severity === 'critical').length,
          pending_changes: (c[a.tenant_id] || []).length,
          reports_awaiting_review: (r[a.tenant_id] || []).filter((x) => x.review_status === 'pending').length,
          last_report_at: latest ? latest.created_at : null,
        };
      }).sort((x, y) => (y.critical - x.critical) || (y.pending_changes - x.pending_changes) || (x.health - y.health));
    },

    // Triage queue: proposed changes across every managed account, one
    // stream, biggest money first.
    triage: async (agencyId) => {
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=eq.active&select=tenant_id,display_name,brief_only`);
      if (!accounts.length) return [];
      const nameByTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('changes',
        `tenant_id=in.(${ids})&status=eq.proposed&select=id,tenant_id,before,after,finding:findings(title,explanation,severity,money_impact_monthly_usd,rule_id,layer,campaign_ref,campaign_name)&order=created_at.asc&limit=200`);
      return rows.map((r) => ({
        id: r.id,
        account: nameByTenant[r.tenant_id] ? nameByTenant[r.tenant_id].display_name : r.tenant_id,
        account_tenant: r.tenant_id,
        brief_only: nameByTenant[r.tenant_id] ? nameByTenant[r.tenant_id].brief_only : false,
        title: r.finding ? r.finding.title : 'Proposed change',
        explanation: r.finding ? r.finding.explanation : '',
        severity: r.finding ? r.finding.severity : 'info',
        rule_id: r.finding ? r.finding.rule_id : null,
        layer: r.finding ? r.finding.layer : null,
        campaign_ref: r.finding ? r.finding.campaign_ref : null,
        campaign_name: r.finding ? r.finding.campaign_name : null,
        money_monthly_usd: r.finding ? r.finding.money_impact_monthly_usd : null,
        before: r.before || null,
        after: r.after || null,
      })).sort((a, b) => (b.money_monthly_usd || 0) - (a.money_monthly_usd || 0));
    },

    // Campaign snapshots across all managed accounts — powers the scope bar
    // dropdowns and name/ID search. Refreshed by the weekly audit runs.
    campaignsFor: async (agencyId) => {
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=in.(pending,active)&select=id,tenant_id,display_name`);
      if (!accounts.length) return [];
      const byTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('campaigns',
        `tenant_id=in.(${ids})&select=tenant_id,google_campaign_id,name,status,channel,budget_daily_usd,bidding&order=name.asc&limit=1000`);
      return rows.map((c) => ({
        account_id: byTenant[c.tenant_id] ? byTenant[c.tenant_id].id : null,
        account: byTenant[c.tenant_id] ? byTenant[c.tenant_id].display_name : null,
        google_campaign_id: c.google_campaign_id,
        name: c.name,
        status: c.status,
        channel: c.channel,
        budget_daily_usd: c.budget_daily_usd,
        bidding: c.bidding,
      }));
    },
    approveChange: async (agencyId, seatId, changeId) => {
      await db.update('changes', `id=eq.${q(changeId)}`, { status: 'approved' });
      await log(agencyId, seatId, 'change_approved', { change_id: changeId });
    },
    dismissChange: async (agencyId, seatId, changeId, reason) => {
      await db.update('changes', `id=eq.${q(changeId)}`, { status: 'failed' });
      const ch = await db.select('changes', `id=eq.${q(changeId)}&select=finding_id`, { single: true });
      if (ch) await db.update('findings', `id=eq.${q(ch.finding_id)}`, { status: 'dismissed' });
      await log(agencyId, seatId, 'change_dismissed', { change_id: changeId, reason: reason || null });
    },

    // Review queue: nothing reaches a client without a seat's approval.
    reviewQueue: async (agencyId) => {
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=eq.active&select=tenant_id,display_name`);
      if (!accounts.length) return [];
      const nameByTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a.display_name]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('reports',
        `tenant_id=in.(${ids})&review_status=eq.pending&select=id,tenant_id,type,created_at&order=created_at.asc`);
      return rows.map((r) => ({ id: r.id, account: nameByTenant[r.tenant_id], type: r.type, created_at: r.created_at }));
    },
    approveReport: async (agencyId, seatId, reportId) => {
      await db.update('reports', `id=eq.${q(reportId)}`, { review_status: 'approved', reviewed_by: seatId, reviewed_at: new Date().toISOString() });
      await log(agencyId, seatId, 'report_approved', { report_id: reportId });
    },
    rejectReport: async (agencyId, seatId, reportId, reason) => {
      await db.update('reports', `id=eq.${q(reportId)}`, { review_status: 'rejected', reviewed_by: seatId, reviewed_at: new Date().toISOString() });
      await log(agencyId, seatId, 'report_rejected', { report_id: reportId, reason: reason || null });
    },

    brandKit: async (agencyId) => db.select('brand_kits',
      `agency_id=eq.${q(agencyId)}&select=*&order=version.desc&limit=1`, { single: true }),
    saveBrandKit: async (agencyId, seatId, kit) => {
      const latest = await db.select('brand_kits', `agency_id=eq.${q(agencyId)}&select=version&order=version.desc&limit=1`, { single: true });
      const version = latest ? latest.version + 1 : 1;
      await db.insert('brand_kits', [{
        agency_id: agencyId, version,
        display_name: kit.display_name || null,
        logo_light_url: kit.logo_light_url || null, logo_dark_url: kit.logo_dark_url || null,
        color_primary: kit.color_primary || null, color_accent: kit.color_accent || null,
        footer_text: kit.footer_text || null,
      }], { returning: false });
      await log(agencyId, seatId, 'brand_kit_saved', { version });
      return { version };
    },

    seats: async (agencyId) => db.select('agency_seats',
      `agency_id=eq.${q(agencyId)}&select=id,email,name,role,status,created_at&order=created_at.asc`),
    addSeat: async (agencyId, seatId, { email, name, role }) => {
      const [row] = await db.insert('agency_seats', [{ agency_id: agencyId, email, name: name || null, role: role || 'am' }]);
      await log(agencyId, seatId, 'seat_invited', { email, role: role || 'am' });
      return row;
    },
    updateSeat: async (agencyId, seatId, targetSeatId, patch) => {
      const allowed = {};
      if (patch.role) allowed.role = patch.role;
      if (patch.status) allowed.status = patch.status;
      await db.update('agency_seats', `id=eq.${q(targetSeatId)}&agency_id=eq.${q(agencyId)}`, allowed);
      await log(agencyId, seatId, 'seat_updated', { seat_id: targetSeatId, ...allowed });
    },

    credits: async (agencyId) => {
      const [bal, events] = await Promise.all([
        db.select('agency_credit_balance', `agency_id=eq.${q(agencyId)}`, { single: true }),
        db.select('audit_credit_events', `agency_id=eq.${q(agencyId)}&select=delta,reason,created_at&order=created_at.desc&limit=50`),
      ]);
      return { balance: bal ? bal.balance : 0, events: events || [] };
    },

    auditLog: async (agencyId) => db.select('agency_audit_log',
      `agency_id=eq.${q(agencyId)}&select=event,detail,created_at,seat:agency_seats(name,email)&order=created_at.desc&limit=100`),

    // ---- account lifecycle + platform billing.
    // Billing principle (binding): we bill the agency for the platform, per
    // billable account (pending or active). Paused/removed accounts never
    // bill. The platform never stores or computes what the agency charges
    // its own clients.
    accountsList: async (agencyId) => db.select('agency_accounts',
      `agency_id=eq.${q(agencyId)}&status=in.(pending,active,paused)&select=id,tenant_id,display_name,status,brief_only,report_register,created_at,seat:agency_seats(name)&order=created_at.asc`),
    addAccount: async (agencyId, seatId, { display_name }) => {
      const [tenant] = await db.insert('tenants', [{ status: 'active', business_name: display_name }]);
      const [row] = await db.insert('agency_accounts',
        [{ agency_id: agencyId, tenant_id: tenant.id, display_name, status: 'pending' }]);
      await log(agencyId, seatId, 'account_added', { account_id: row.id, display_name });
      return row;
    },
    setAccountStatus: async (agencyId, seatId, accountId, status) => {
      await db.update('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}`, { status });
      await log(agencyId, seatId, `account_${status}`, { account_id: accountId });
    },
    billing: async (agencyId, nowIso) => {
      const { monthlyCharge, prorateAdd, cycleFor } = require('../../billing/src/agency-pricing');
      const now = nowIso || new Date().toISOString();
      const [ag, billable] = await Promise.all([
        db.select('agencies', `id=eq.${q(agencyId)}&select=platform_tier,billing_anchor,created_at`, { single: true }),
        db.select('agency_accounts', `agency_id=eq.${q(agencyId)}&status=in.(pending,active)&select=id`),
      ]);
      const n = (billable || []).length;
      const tier = (ag && ag.platform_tier) || 'base';
      const cycle = cycleFor((ag && (ag.billing_anchor || ag.created_at)) || now, now);
      return {
        ...monthlyCharge(n, tier),
        tier,
        cycle,
        add_today_prorated: prorateAdd({ countAfterAdd: n + 1, daysRemaining: cycle.daysRemaining, daysInPeriod: cycle.daysInPeriod }),
      };
    },
  };
}

// ---------------------------------------------------------------- auth (Supabase session bridge)
function authStore(db) {
  return {
    /** users by google sub → tenant; first login creates tenant + user. */
    findOrCreateTenantByGoogle: async ({ sub, email, name }) => {
      const existing = await db.select('users', `google_sub=eq.${q(sub)}&select=tenant_id&limit=1`, { single: true });
      if (existing) {
        await db.update('users', `google_sub=eq.${q(sub)}`, { last_seen_at: new Date().toISOString() }).catch(() => {});
        return existing.tenant_id;
      }
      const [tenant] = await db.insert('tenants', [{ status: 'active' }]);
      await db.insert('users', [{ tenant_id: tenant.id, google_sub: sub, email, name: name || null }], { returning: false });
      await db.insert('ledger', [{ tenant_id: tenant.id, event: 'connection_changed', actor: 'system', summary_text: 'Account created with Google sign-in.' }], { returning: false }).catch(() => {});
      return tenant.id;
    },
  };
}

module.exports = { workerStore, webStore, executorStore, billingStore, opsStore, dashStore, agencyStore, authStore };
