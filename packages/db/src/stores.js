// Store adapters — the real Supabase implementations of every store contract
// the apps consume. One factory per consumer, all over one PostgREST client.
// Contracts are defined by the consumers (apps/worker/src/*, apps/web/src/*,
// packages/tools/src/executor.js, packages/billing/src/webhooks.js) — these
// adapters exist to satisfy them against the deployed §1 schema.

const q = (s) => encodeURIComponent(s);
const createTelemetryBeat = (db, stream) => require('../../shared/src/telemetry').createTelemetry({ db }).beat(stream);

// ---------------------------------------------------------------- worker
function workerStore(db) {
  return {
    tenantWebsite: async (tenantId) => {
      const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true });
      return t ? t.website_url : null;
    },
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
    // §5.1 journey/setup input for journeyB.setup_incomplete
    setupState: async (tenantId) => {
      const [j, assets] = await Promise.all([
        db.select('journey_state', `tenant_id=eq.${q(tenantId)}&select=journey,gates&limit=1`, { single: true }).catch(() => null),
        db.select('assets', `tenant_id=eq.${q(tenantId)}&linked=eq.true&select=kind`).catch(() => []),
      ]);
      return { journey: j ? j.journey : 'A', gates: (j && j.gates) || { tag: true, billing: true, approval: true }, linked: (assets || []).map((a) => a.kind) };
    },
    // ---- §6.1 diff_pass
    openFindings: async (tenantId) => db.select('findings',
      `select=id,rule_id,entity_key:payload->>entity_key,status,title,first_seen_run_id,first_seen_at,created_at&tenant_id=eq.${q(tenantId)}&status=in.(open,approved,suspect)`).catch(() => []),
    hasPriorRun: async (tenantId, runId) => {
      const rows = await db.select('runs', `tenant_id=eq.${q(tenantId)}&id=neq.${q(runId)}&status=in.(complete,degraded)&select=id&limit=1`).catch(() => []);
      return !!(rows && rows.length);
    },
    applyDiff: async (tenantId, runId, { supersede = [], resolved = [] }) => {
      if (supersede.length) {
        await db.update('findings', `id=in.(${supersede.map(q).join(',')})`, { status: 'superseded' }).catch(() => {});
      }
      if (resolved.length) {
        await db.update('findings', `id=in.(${resolved.map((r) => q(r.id)).join(',')})`, { status: 'resolved', resolved_run_id: runId }).catch(() => {});
        // One ledger line per resolved finding: it stopped firing without us
        // applying a change — either it fixed itself or the owner fixed it.
        await db.insert('ledger', resolved.map((r) => ({
          tenant_id: tenantId, event: 'finding_resolved', actor: 'system',
          summary_text: `${r.title ? `"${r.title}"` : r.rule_id.replace(/[._]/g, ' ')} is no longer showing up — it fixed itself or you fixed it. We noticed.`,
        })), { returning: false }).catch(() => {});
      }
    },
    ledgerCumulative: async (tenantId) => db.select('ledger_cumulative', `tenant_id=eq.${q(tenantId)}`, { single: true }),
    saveFindings: async (runId, findings) => {
      if (!findings.length) return;
      await db.insert('findings', findings.map((f) => ({
        id: f.finding_id, run_id: runId, tenant_id: f.tenant_id, rule_id: f.rule_id,
        layer: f.layer, severity: f.severity, status: f.status,
        title: f.title, explanation: f.explanation,
        money_impact_monthly_usd: f.money ? f.money.impact_monthly_usd : null,
        money_impact_currency_local: f.money ? (f.money.impact_monthly_local || (f.money.currency ? { code: f.money.currency } : null)) : null,
        payload: { ...f.payload, entity_key: f.entity_key },
        fix_available: !!(f.fix && f.fix.available),
        first_seen_run_id: f.first_seen_run_id,
        first_seen_at: f.first_seen_at || null,
      })), { returning: false });
    },
    saveReport: async (runId, { html_email, html_web, findings_snapshot, tenant_id, type, summary = null }) => {
      // Once the audit fee is paid every later report is born unlocked.
      const paid = await db.select('payments', `tenant_id=eq.${q(tenant_id)}&kind=in.(audit_unlock,large_audit,setup_bundle)&select=id&limit=1`, { single: true }).catch(() => null);
      await db.insert('reports', [{
        run_id: runId, tenant_id, type: type || 'weekly',
        html_email, html_web, findings_snapshot: findings_snapshot || [], summary,
        ...(paid ? { unlocked: true, unlocked_at: new Date().toISOString() } : {}),
      }], { returning: false });
    },
    // Snapshot stage (§6.3/6.4/§11.3): campaigns + spend_daily + asset
    // labels, refreshed by every run so pacing, the spend card and the
    // creative loop read stored data — never live Google calls.
    saveSnapshots: async (tenantId, ads, runId = null) => {
      const out = { campaigns: 0, days: 0, assets: 0 };
      const nowIso = new Date().toISOString();
      const camps = (ads.campaigns || []).filter((c) => c && c.id && !String(c.id).startsWith('draft-'));
      if (camps.length) {
        await db.upsert('campaigns', camps.map((c) => ({
          tenant_id: tenantId, google_campaign_id: String(c.id), name: c.name || String(c.id),
          status: c.status || null, channel: c.channel || 'search',
          budget_daily_usd: c.budget_daily_usd != null ? Math.round(c.budget_daily_usd * 100) / 100 : null,
          bidding: c.bidding && c.bidding.strategy ? c.bidding.strategy : null, last_seen_at: nowIso,
          budget_resource: c.budget_resource || null,
        })), 'tenant_id,google_campaign_id');
        out.campaigns = camps.length;
      }
      const daily = ads.deep && Array.isArray(ads.deep.daily) ? ads.deep.daily : [];
      if (daily.length) {
        await db.upsert('spend_daily', daily.map((d) => ({
          tenant_id: tenantId, date: d.date, spend_usd: d.cost_usd || 0,
          conversions: d.conversions || 0, conversion_value_usd: d.conversion_value_usd || 0,
        })), 'tenant_id,date');
        out.days = daily.length;
      }
      const assets = ads.deep && Array.isArray(ads.deep.assets) ? ads.deep.assets : [];
      if (assets.length) {
        const { createTelemetry } = require('../../shared/src/telemetry');
        await createTelemetry({ db }).assetSnapshot({ tenantId, runId, assets });
        out.assets = assets.length;
      }
      if (daily.length) await createTelemetryBeat(db, 'spend_daily');
      return out;
    },
    // ---- §6.1 draft_pass state: what the registry must respect this run.
    draftState: async (tenantId) => {
      const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [auto, exc, open, recent, reverted, budgetMoves, camps] = await Promise.all([
        db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }).catch(() => null),
        db.select('standing_exceptions', `tenant_id=eq.${q(tenantId)}&cleared_at=is.null&select=change_key`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=in.(proposed,approved)&select=target`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.applied&applied_at=gte.${q(since30)}&select=change_key`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.reverted&applied_at=gte.${q(since30)}&select=id`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&tool_id=eq.ads.adjust_budget&status=eq.applied&applied_at=gte.${q(since7)}&select=params`).catch(() => []),
        db.select('campaigns', `tenant_id=eq.${q(tenantId)}&status=eq.enabled&select=google_campaign_id,budget_daily_usd`).catch(() => []),
      ]);
      const cats = (auto && auto.categories) || {};
      const dailyTotal = (camps || []).reduce((s, c) => s + Number(c.budget_daily_usd || 0), 0) || 1;
      const weeklyDelta = (budgetMoves || []).reduce((s, c) => s + Math.abs(Number((c.params || {}).new_daily_usd || 0) - Number((c.params || {}).previous_daily_usd || 0)), 0) / dailyTotal * 100;
      const campMap = new Map((camps || []).map((c) => [String(c.google_campaign_id), { budget_daily_usd: Number(c.budget_daily_usd || 0) }]));
      return {
        autopilot: { negatives: cats.negatives === true || cats.negatives === 'auto', budgets: cats.budgets === true || cats.budgets === 'auto', counting: cats.counting === true || cats.counting === 'auto' },
        exceptions: new Set((exc || []).map((e) => e.change_key)),
        inflight: new Set((open || []).map((c) => c.target).filter(Boolean)),
        recent: new Set((recent || []).map((c) => c.change_key).filter(Boolean)),
        bounds: {
          account: { daily_budget_total_usd: dailyTotal },
          campaign: (id) => campMap.get(String(id)) || null,
          weekly_budget_delta_pct: Math.round(weeklyDelta * 10) / 10,
          converting_terms: new Set(), // filled by the executor ctx at apply time; drafts re-check there
          reverted_30d: (reverted || []).length,
        },
      };
    },
    // Persist drafted changes. Autopilot drafts are born approved (standing
    // consent, approvals channel 'autopilot', ledger actor autopilot) and the
    // apply loop picks them up within a minute; the rest are cards.
    saveDrafts: async (runId, tenantId, drafts, skipped = []) => {
      const out = { cards: 0, autopilot: 0, skipped: skipped.length };
      if (!drafts.length) return out;
      // Bounds state's converting-term set is empty at draft time; the rule
      // itself excludes converting terms, and the tool guard re-checks at apply.
      const rows = drafts.map((d) => ({
        tenant_id: tenantId, finding_id: d.finding_id, tool_id: d.tool_id, params: d.params,
        status: d.mode === 'autopilot' ? 'approved' : 'proposed',
        actor: d.mode === 'autopilot' ? 'autopilot' : 'user',
        change_key: d.change_key, target: d.target, category: d.category,
        before: d.before, after: d.after, summary_text: d.summary, money_impact_usd: d.money_impact_usd,
        ask_reason: d.mode === 'ask' ? d.reason : null,
        watch_plan: { kind: d.watch ? d.watch.kind : null, days: d.watch ? d.watch.days : null, baseline: d.baseline || {} },
        reverts_change_id: d.reverts_change_id || null,
        idempotency_key: `${runId}:${d.change_key}`,
      }));
      const inserted = await db.insert('changes', rows);
      for (const r of inserted || []) {
        if (r.status === 'approved') {
          out.autopilot += 1;
          await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: r.id, channel: 'autopilot' }], { returning: false }).catch(() => {});
          await db.insert('ledger', [{ tenant_id: tenantId, event: 'autopilot_applied', change_id: r.id, actor: 'autopilot',
            summary_text: `Autopilot is applying: ${r.summary_text}. Watching it for ${r.watch_plan && r.watch_plan.days ? r.watch_plan.days : 7} days.`, money_impact_usd: r.money_impact_usd }], { returning: false }).catch(() => {});
        } else {
          out.cards += 1;
          await db.insert('ledger', [{ tenant_id: tenantId, event: 'fix_proposed', change_id: r.id, actor: 'system',
            summary_text: `Ready for your approval: ${r.summary_text}.`, money_impact_usd: r.money_impact_usd }], { returning: false }).catch(() => {});
        }
      }
      if (skipped.some((k) => /suspect-heavy/.test(k.reason || ''))) {
        await db.insert('ledger', [{ tenant_id: tenantId, event: 'engine_paused', actor: 'system',
          summary_text: 'Two or more changes were undone recently, so we are pausing new suggestions until a person reviews the account.' }], { returning: false }).catch(() => {});
      }
      return out;
    },
    // ---- §6.1 watch_close: due per-change watches joined to their change.
    dueChangeWatches: async (tenantId) => {
      const nowIso = new Date().toISOString();
      const watches = await db.select('watches',
        `tenant_id=eq.${q(tenantId)}&kind=eq.change_verify&status=eq.active&schedule->>until=lte.${q(nowIso)}&select=*`).catch(() => []);
      if (!watches || !watches.length) return [];
      const ids = watches.map((w) => w.target_id).filter(Boolean).map(q).join(',');
      const changes = ids ? await db.select('changes', `id=in.(${ids})&select=id,tool_id,params,target,summary_text,after,actor,change_key`).catch(() => []) : [];
      const byId = new Map((changes || []).map((c) => [c.id, c]));
      return watches.map((watch) => ({ watch, change: byId.get(watch.target_id) || null }));
    },
    closeChangeWatch: async ({ watch, change, verdict, rollback, tenantId }) => {
      const nowIso = new Date().toISOString();
      await db.update('watches', `id=eq.${q(watch.id)}`, { status: 'resolved', outcome: verdict.outcome, effect: verdict.effect, closed_at: nowIso, last_check_at: nowIso });
      const event = { verified: 'watch_verified', inconclusive: 'watch_inconclusive', regressed: 'watch_regressed' }[verdict.outcome];
      await db.insert('ledger', [{ tenant_id: tenantId, event, change_id: change ? change.id : null, actor: 'system',
        summary_text: `${change ? change.summary_text || change.tool_id : 'A change'}: ${verdict.line}` }], { returning: false }).catch(() => {});
      // Tracking breakage: the one auto-revert (§9.3) — money protection.
      if (verdict.outcome === 'regressed' && verdict.tracking_breakage && rollback && change) {
        const [rb] = await db.insert('changes', [{
          tenant_id: tenantId, finding_id: change.finding_id || null, tool_id: rollback.tool_id, params: rollback.params,
          status: 'approved', actor: 'system', change_key: `rollback:${change.change_key}`, target: change.target,
          summary_text: `Auto-reverted: ${change.summary_text || change.tool_id}`, reverts_change_id: change.id,
          before: { line: verdict.line }, after: { line: 'Counting is back to how it was' },
          idempotency_key: `rollback:${change.id}`,
        }]).catch(() => [null]);
        await db.update('changes', `id=eq.${q(change.id)}`, { status: 'reverted' }).catch(() => {});
        await db.insert('ledger', [{ tenant_id: tenantId, event: 'auto_reverted', change_id: rb ? rb.id : null, actor: 'system',
          summary_text: `We undid "${change.summary_text || change.tool_id}" straight away: ${verdict.line}` }], { returning: false }).catch(() => {});
      }
    },
    // "Against your goals" report section — non-null only when targets are
    // set for this tenant (agency accounts). Month-to-date actuals + pacing.
    performanceFor: async (tenantId) => {
      const t = await db.select('account_targets', `tenant_id=eq.${q(tenantId)}&select=*`, { single: true }).catch(() => null);
      if (!t || (t.monthly_budget_usd == null && t.cpa_target_usd == null && t.roas_target == null)) return null;
      const now = new Date();
      const monthStart = `${now.toISOString().slice(0, 8)}01`;
      const days = await db.select('spend_daily',
        `tenant_id=eq.${q(tenantId)}&date=gte.${q(monthStart)}&select=spend_usd,conversions,conversion_value_usd`).catch(() => []);
      const sum = (k) => (days || []).reduce((n, d) => n + Number(d[k] || 0), 0);
      const { pace } = require('../../pacing/src/pacing');
      const spend = sum('spend_usd');
      return {
        month_label: now.toLocaleDateString('en-GB', { month: 'long' }),
        spend_usd: spend,
        conversions: sum('conversions'),
        conversion_value_usd: sum('conversion_value_usd'),
        targets: {
          monthly_budget_usd: t.monthly_budget_usd != null ? Number(t.monthly_budget_usd) : null,
          cpa_target_usd: t.cpa_target_usd != null ? Number(t.cpa_target_usd) : null,
          roas_target: t.roas_target != null ? Number(t.roas_target) : null,
        },
        pacing: t.monthly_budget_usd != null
          ? pace({ monthlyBudgetUsd: Number(t.monthly_budget_usd), mtdSpendUsd: spend, nowIso: now.toISOString() })
          : null,
      };
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
    recordPayment: async (row) => {
      await db.insert('payments', [row], { returning: false });
      // The $20 (or large-account) audit fee unlocks every report the tenant
      // has and will have: reports are rendered locked, the flag opens them.
      if (['audit_unlock', 'large_audit', 'setup_bundle'].includes(row.kind)) {
        await db.update('reports', `tenant_id=eq.${q(row.tenant_id)}`, { unlocked: true, unlocked_at: new Date().toISOString() }).catch(() => {});
      }
    },
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
    learningReviews: async () => db.select('learning_reviews', 'select=month,body_md,proposals,incidents,created_at&order=month.desc&limit=12').catch(() => []),
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
function dashStore(db, deps = {}) {
  const { healthScore } = require('../../rules/src/engine');
  const { createTelemetry } = require('../../shared/src/telemetry');
  const { createDraftService } = require('../../campaigns/src/service');
  const { renderPlain } = require('../../campaigns/src/builder');
  const tel = createTelemetry({ db });
  const draftsSvc = createDraftService({ db, google: deps.google || null, model: deps.model || null, modelId: deps.modelId || null });
  const plainDraft = (d) => ({ id: d.id, status: d.status, template: d.template, plain: renderPlain(d.spec), gates: d.spec.gates || null, budget_daily_usd: d.spec.budget_daily_usd, name: d.spec.name, ad_groups: d.spec.ad_groups.map((g) => ({ name: g.name, rsa: g.rsa })), created_at: d.created_at });
  return {
    // ---- §5 consumer door: "your ad" drafts in the customer register.
    drafts: async (tenantId) => (await db.select('campaign_drafts', `tenant_id=eq.${q(tenantId)}&agency_id=is.null&status=neq.dismissed&select=*&order=created_at.desc&limit=20`).catch(() => [])).map(plainDraft),
    createDraft: async (tenantId, { template, inputs }) => plainDraft(await draftsSvc.create({ tenantId, template, inputs: inputs || {} })),
    draftAction: async (tenantId, draftId, action, body = {}) => {
      if (action === 'edit') return draftsSvc.edit({ tenantId, draftId, adGroups: body.ad_groups || [] });
      if (action === 'approve') return draftsSvc.approve({ tenantId, draftId, actor: 'user' });
      if (action === 'enable') return draftsSvc.enable({ tenantId, draftId, actor: 'user' });
      if (action === 'dismiss') return draftsSvc.dismiss({ tenantId, draftId });
      return { error: `Unknown action ${action}.` };
    },
    setupSteps: async (tenantId) => draftsSvc.gatesFor(tenantId),
    // §5.1: one tap → we create what is missing (GA4 property, GTM container).
    provisionSetup: async (tenantId) => {
      if (!deps.provisioner) return { error: 'Not available yet.' };
      const r = await deps.provisioner.provision(tenantId);
      await tel.event({ tenantId, name: 'setup.provisioned', props: { ga4: !!r.ga4, gtm: !!r.gtm, guides: r.guides.length }, source: 'server' });
      return r;
    },
    // §11 telemetry: dashboard interactions land in `events`. Best-effort.
    trackEvent: (tenantId, name, props, sessionKey) => tel.event({ tenantId, name, props, source: 'app', sessionKey }),
    // Consumer spend card (§6.4). Month-to-date from spend_daily snapshots;
    // the month budget is the explicit target when one is set, else the sum
    // of enabled daily budgets across the month. Null until the first
    // snapshot lands — the card simply does not render.
    spendPosition: async (tenantId, now = new Date()) => {
      const monthStart = `${now.toISOString().slice(0, 7)}-01`;
      const [days, target, camps] = await Promise.all([
        db.select('spend_daily', `tenant_id=eq.${q(tenantId)}&date=gte.${q(monthStart)}&select=date,spend_usd`).catch(() => []),
        db.select('account_targets', `tenant_id=eq.${q(tenantId)}&select=monthly_budget_usd`, { single: true }).catch(() => null),
        db.select('campaigns', `tenant_id=eq.${q(tenantId)}&status=eq.enabled&select=budget_daily_usd`).catch(() => []),
      ]);
      if (!days || !days.length) return null;
      const { pace } = require('../../pacing/src/pacing');
      const mtd = days.reduce((s, d) => s + Number(d.spend_usd || 0), 0);
      const dailySum = (camps || []).reduce((s, c) => s + Number(c.budget_daily_usd || 0), 0);
      const p = pace({ monthlyBudgetUsd: 0, mtdSpendUsd: mtd, nowIso: now.toISOString() });
      const budget = target && target.monthly_budget_usd != null
        ? Number(target.monthly_budget_usd)
        : (dailySum > 0 ? Math.round(dailySum * p.daysInMonth * 100) / 100 : null);
      const monthPct = Math.round((p.dayOfMonth / p.daysInMonth) * 100);
      let paceLine = null;
      if (budget) {
        const spentPct = Math.round((mtd / budget) * 100);
        const gap = spentPct - monthPct;
        const word = gap > 8 ? 'Ahead of pace' : gap < -8 ? 'Behind pace' : 'On pace';
        paceLine = `${word} - ${spentPct}% spent, ${monthPct}% of the month gone`;
      } else {
        paceLine = `${monthPct}% of the month gone; no monthly budget set`;
      }
      return {
        month_usd: Math.round(mtd * 100) / 100,
        month_budget_usd: budget,
        pace_line: paceLine,
        as_of: days.map((d) => d.date).sort().at(-1),
        budget_source: target && target.monthly_budget_usd != null ? 'target' : (budget ? 'daily_budgets' : null),
      };
    },
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
    accountCurrency: async (tenantId) => {
      const a = await db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.ads_account&select=currency&limit=1`, { single: true }).catch(() => null);
      return (a && a.currency) || 'USD';
    },
    pendingApprovals: async (tenantId) => {
      // Change summaries are written for the ledger (past tense: "Excluded…").
      // On a card that is still waiting for a yes they must read as proposals.
      const PROPOSE = [[/^Excluded /, 'Exclude '], [/^Raised /, 'Raise '], [/^Lowered /, 'Lower '], [/^Paused /, 'Pause '], [/^Linked /, 'Link '], [/^Undid /, 'Undo '], [/^Set /, 'Set '], [/^Added /, 'Add '], [/^Removed /, 'Remove '], [/^Enabled /, 'Enable '], [/^Created /, 'Create ']];
      const asProposal = (t) => { for (const [re, to] of PROPOSE) if (re.test(t)) return t.replace(re, to); return t; };
      const cur = await (async () => {
        const a = await db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.ads_account&select=currency&limit=1`, { single: true }).catch(() => null);
        return (a && a.currency) || 'USD';
      })();
      const sym = cur === 'USD' ? '$' : `${cur} `;
      const rows = await db.select('changes',
        `tenant_id=eq.${q(tenantId)}&status=eq.proposed&select=id,before,after,summary_text,money_impact_usd,ask_reason,category,finding:findings(title,explanation,money_impact_monthly_usd)&order=created_at.desc`);
      return rows.map((r) => ({
        id: r.id,
        title: r.summary_text ? asProposal(r.summary_text) : ((r.finding && r.finding.title) || 'A fix is ready'),
        money_line: (r.money_impact_usd || (r.finding && r.finding.money_impact_monthly_usd))
          ? `about ${sym}${Math.round(r.money_impact_usd || r.finding.money_impact_monthly_usd)} a month` : null,
        category: r.category || null,
        ask_reason: r.ask_reason || null,
        // The trust layer: what exactly changes, in plain words, on the card
        // itself. Falls back to the raw before/after when no prose exists.
        explanation: (r.finding && r.finding.explanation) || null,
        before_line: r.before ? (r.before.line || JSON.stringify(r.before).slice(0, 140)) : null,
        after_line: r.after ? (r.after.line || JSON.stringify(r.after).slice(0, 140)) : null,
      }));
    },
    // ---- §7 assistant. The composer is the bot's entry point (§7.4.8): when
    // the assistant is wired, a composer request becomes a chat turn.
    assistantEnabled: async (tenantId) => {
      const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=assistant_enabled`, { single: true }).catch(() => null);
      return !!(t && t.assistant_enabled) && !!deps.assistant;
    },
    chat: async (tenantId, text, conversationId) => (deps.assistant ? deps.assistant.turn({ tenantId, text, conversationId }) : null),
    chatTranscript: async (tenantId, conversationId) => (deps.assistant ? deps.assistant.transcript(tenantId, conversationId) : null),
    chatConsent: async (tenantId) => (deps.assistant ? deps.assistant.consent(tenantId) : { ok: false }),
    // User-initiated request (dashboard composer). Recorded to the ledger so
    // it is on the record immediately; with the assistant wired it is drafted
    // into a card right away, otherwise it waits for the team.
    requestChange: async (tenantId, text) => {
      if (deps.assistant) {
        const r = await deps.assistant.turn({ tenantId, text });
        return { drafted: !!r.card, reply: r.reply, card: r.card };
      }
      const clean = String(text || '').slice(0, 500);
      await db.insert('ledger', [{
        tenant_id: tenantId, event: 'change_requested', actor: 'user',
        summary_text: `You asked: "${clean}". We will draft it as a change for your approval.`,
      }], { returning: false });
      await db.insert('audit_log', [{ tenant_id: tenantId, event: 'change_requested', detail: { text: clean } }], { returning: false }).catch(() => {});
      // Until the drafting flow (phase 5) maps it, every request is also an
      // unanswered-log row — the customer-written backlog (§11.4).
      await tel.unanswered({ tenantId, source: 'composer', text: clean });
      await tel.event({ tenantId, name: 'approval.request_change', props: { chars: clean.length }, source: 'server' });
    },
    setAutopilot: async (tenantId, categories) => {
      const allowed = ['negatives', 'budgets', 'counting'];
      const clean = {};
      for (const k of allowed) clean[k] = !!(categories && categories[k]);
      const existing = await db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=tenant_id`, { single: true }).catch(() => null);
      if (existing) await db.update('autopilot_settings', `tenant_id=eq.${q(tenantId)}`, { categories: clean });
      else await db.insert('autopilot_settings', [{ tenant_id: tenantId, categories: clean }], { returning: false });
      return clean;
    },
    cumulative: async (tenantId) => {
      const row = await db.select('ledger_cumulative', `tenant_id=eq.${q(tenantId)}`, { single: true });
      return row ? { fixes: row.fixes_applied, waste_removed_usd: Math.round(row.waste_removed_usd) } : null;
    },
    reports: async (tenantId) => db.select('reports', `tenant_id=eq.${q(tenantId)}&select=id,type,created_at,viewed_at&order=created_at.desc&limit=50`),
    reportData: async (tenantId, reportId) => {
      const r = await db.select('reports',
        `id=eq.${q(reportId)}&tenant_id=eq.${q(tenantId)}&select=id,type,created_at,findings_snapshot,unlocked,summary`, { single: true });
      if (r) await db.update('reports', `id=eq.${q(reportId)}`, { viewed_at: new Date().toISOString() }).catch(() => {});
      return r;
    },
    ledger: async (tenantId) => db.select('ledger', `tenant_id=eq.${q(tenantId)}&select=*&order=created_at.desc&limit=100`),
    settings: async (tenantId) => {
      // users → google_connections (one owner per tenant in v1). PostgREST has
      // no SQL subqueries; the old `user_id=in.(select …)` filter 400'd and every
      // tenant read "Google connection pending." whatever the real status.
      const [sub, auto, owner] = await Promise.all([
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,size_band,price_usd,status&limit=1`, { single: true }),
        db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }),
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=id&limit=1`, { single: true }).catch(() => null),
      ]);
      const conn = owner
        ? await db.select('google_connections', `user_id=eq.${q(owner.id)}&select=status&limit=1`, { single: true }).catch(() => null)
        : null;
      const CONNECTION_LINE = {
        valid: 'Google connection healthy.',
        expired: 'Google connection expired - sign in again to reconnect.',
        revoked: 'Google access was removed - sign in again to reconnect.',
      };
      return {
        plan_line: sub ? `${sub.tier[0].toUpperCase()}${sub.tier.slice(1)} · $${sub.price_usd}/mo (${sub.status})` : 'Free check — no plan yet',
        autopilot: (auto && auto.categories) || {},
        connection_status: (conn && CONNECTION_LINE[conn.status]) || 'Google connection pending.',
        assistant_enabled: !!deps.assistant && !!(await db.select('tenants', `id=eq.${q(tenantId)}&select=assistant_enabled`, { single: true }).catch(() => null) || {}).assistant_enabled,
      };
    },
    discovery: async (tenantId) => {
      const assets = await db.select('assets', `tenant_id=eq.${q(tenantId)}&select=id,kind,external_id,display_name,linked`);
      return { matched: assets.filter((a) => a.linked), unmatched: assets.filter((a) => !a.linked) };
    },
    // Link only what the confirm page presented as "your setup": assets matched
    // to the site's tags (matched_via set by discovery) or chosen by the owner.
    // The "other items we can see but didn't match your site" stay unlinked -
    // one Google login often spans several businesses, and auditing (or
    // proposing changes for) a sibling business's Ads account is never OK.
    confirmAssets: async (tenantId) => {
      await db.update('assets', `tenant_id=eq.${q(tenantId)}&metadata->>matched_via=not.is.null`, { linked: true });
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
      const ch = await db.select('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&select=tool_id,params`, { single: true }).catch(() => null);
      if (ch && ch.tool_id === 'settings.autopilot_on') {
        // A settings card, not an Ads write: the tap IS the flip (§7.2 lane 2).
        const cur = await db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }).catch(() => null);
        const next = { ...((cur && cur.categories) || {}) };
        for (const c of (ch.params && ch.params.categories) || []) next[c] = true;
        const clean = { negatives: !!next.negatives, budgets: !!next.budgets, counting: !!next.counting };
        if (cur) await db.update('autopilot_settings', `tenant_id=eq.${q(tenantId)}`, { categories: clean });
        else await db.insert('autopilot_settings', [{ tenant_id: tenantId, categories: clean }], { returning: false });
        await db.update('changes', `id=eq.${q(changeId)}`, { status: 'applied', applied_at: new Date().toISOString() });
        await db.insert('ledger', [{ tenant_id: tenantId, event: 'fix_applied', actor: 'user', change_id: changeId, summary_text: `Autopilot is on for ${((ch.params && ch.params.categories) || []).join(', ')}. Everything it does stays reversible and lands in your history.` }], { returning: false }).catch(() => {});
        await tel.event({ tenantId, name: 'approval.approve', props: { change_id: changeId, settings: true }, source: 'server' });
        return;
      }
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}`, { status: 'approved' });
      await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: changeId, channel: 'dashboard' }], { returning: false });
      await tel.event({ tenantId, name: 'approval.approve', props: { change_id: changeId }, source: 'server' });
    },
    dismissChange: async (tenantId, changeId, { reason = null, expandedFirst = false } = {}) => {
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}`, { status: 'failed' });
      const ch = await db.select('changes', `id=eq.${q(changeId)}&select=finding_id,finding:findings(rule_id)`, { single: true });
      if (ch) await db.update('findings', `id=eq.${q(ch.finding_id)}`, { status: 'dismissed' });
      // §11.2 human-judgment label: the optional one-tap reason + whether the
      // detail was opened first ("finding wrong" vs "explanation failed").
      await tel.dismissal({
        tenantId, changeId, findingId: ch ? ch.finding_id : null, ruleId: ch && ch.finding ? ch.finding.rule_id : null,
        reasonTap: reason, expandedFirst,
      });
    },
    // §4.5 revert: the registry derives the reverse change, it is born
    // approved (the tap IS the approval), the original is marked reverted and
    // its finding returns as suspect. Undoing an AUTOPILOT change also writes
    // a standing exception: never re-applied on its own again.
    requestRevert: async (tenantId, changeId) => {
      await db.insert('audit_log', [{ tenant_id: tenantId, event: 'revert_requested', detail: { change_id: changeId } }], { returning: false });
      const ch = await db.select('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&select=*`, { single: true }).catch(() => null);
      if (!ch || ch.status !== 'applied') return { ok: false, reason: 'Only applied changes can be undone.' };
      const { byTool } = require('../../registry/src/registry');
      const row = byTool(ch.tool_id);
      const rollback = row && row.rollback ? row.rollback(ch) : null;
      if (!rollback) return { ok: false, reason: 'This change cannot be undone automatically; we have logged your request for the team.' };
      const [rb] = await db.insert('changes', [{
        tenant_id: tenantId, finding_id: ch.finding_id, tool_id: rollback.tool_id, params: rollback.params,
        status: 'approved', actor: 'user', change_key: `rollback:${ch.change_key || ch.id}`, target: ch.target,
        summary_text: `Undid: ${ch.summary_text || ch.tool_id}`, reverts_change_id: ch.id,
        before: { line: ch.after && ch.after.line ? ch.after.line : 'As changed' }, after: { line: ch.before && ch.before.line ? ch.before.line : 'Back to how it was' },
        idempotency_key: `rollback:${ch.id}:${Date.now()}`,
      }]);
      await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: rb.id, channel: 'dashboard' }], { returning: false }).catch(() => {});
      await db.update('changes', `id=eq.${q(ch.id)}`, { status: 'reverted' }).catch(() => {});
      if (ch.finding_id) await db.update('findings', `id=eq.${q(ch.finding_id)}`, { status: 'suspect' }).catch(() => {});
      await db.insert('ledger', [{ tenant_id: tenantId, event: 'fix_reverted', change_id: ch.id, actor: 'user',
        summary_text: `You asked us to undo: ${ch.summary_text || ch.tool_id}. It is being reversed now.` }], { returning: false }).catch(() => {});
      if (ch.actor === 'autopilot' && ch.change_key) {
        await db.insert('standing_exceptions', [{ tenant_id: tenantId, change_key: ch.change_key, target: ch.target,
          summary_text: ch.summary_text || ch.tool_id, created_from: 'revert', source_change_id: ch.id }], { returning: false }).catch(() => {});
        await db.insert('ledger', [{ tenant_id: tenantId, event: 'exception_added', change_id: ch.id, actor: 'user',
          summary_text: `Noted: autopilot will never re-apply "${ch.summary_text || ch.tool_id}" on its own. You can clear this in Settings.` }], { returning: false }).catch(() => {});
      }
      return { ok: true, rollback_change_id: rb.id };
    },
    // "What have I told you never to touch?" (§4.5) — listable and clearable.
    exceptions: async (tenantId) => db.select('standing_exceptions',
      `tenant_id=eq.${q(tenantId)}&cleared_at=is.null&select=id,summary_text,target,created_from,created_at&order=created_at.desc`).catch(() => []),
    clearException: async (tenantId, id) => {
      const rows = await db.update('standing_exceptions', `id=eq.${q(id)}&tenant_id=eq.${q(tenantId)}&cleared_at=is.null`, { cleared_at: new Date().toISOString() }).catch(() => []);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) await db.insert('ledger', [{ tenant_id: tenantId, event: 'exception_cleared', actor: 'user',
        summary_text: `Cleared: "${row.summary_text}" may be suggested again (autopilot still asks first the next time).` }], { returning: false }).catch(() => {});
      return !!row;
    },
  };
}

// ---------------------------------------------------------------- agency (master §13)
// Binding: no auto-apply, no auto-publish. Every mutation logs to
// agency_audit_log with the acting seat — the agency's own dispute record.
function agencyStore(db, deps = {}) {
  const { healthScore } = require('../../rules/src/engine');
  const { pace, sortPacing, targetStatus } = require('../../pacing/src/pacing');
  const { createDraftService } = require('../../campaigns/src/service');
  const drafts = createDraftService({ db, google: deps.google || null, model: deps.model || null, modelId: deps.modelId || null });
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
        `tenant_id=in.(${ids})&status=eq.proposed&select=id,tenant_id,before,after,snoozed_until,snooze_reason,finding:findings(title,explanation,severity,money_impact_monthly_usd,rule_id,layer,campaign_ref,campaign_name,payload)&order=created_at.asc&limit=200`);
      return rows.map((r) => ({
        id: r.id,
        snoozed_until: r.snoozed_until || null,
        snooze_reason: r.snooze_reason || null,
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
        build_template: r.finding && r.finding.payload ? r.finding.payload.build_template || null : null,
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
    // ---- Campaign creation (design doc): a build is the biggest possible
    // "change". Drafts flow approve → created PAUSED → enable (second
    // explicit click). Never created enabled. Every step seat-logged.
    draftsFor: async (agencyId) => {
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=in.(pending,active)&select=id,tenant_id,display_name`);
      if (!accounts.length) return [];
      const byTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('campaign_drafts',
        `tenant_id=in.(${ids})&status=neq.dismissed&select=*&order=created_at.desc&limit=100`);
      return rows.map((d) => ({
        ...d,
        account_id: byTenant[d.tenant_id] ? byTenant[d.tenant_id].id : null,
        account: byTenant[d.tenant_id] ? byTenant[d.tenant_id].display_name : null,
      }));
    },
    createDraft: async (agencyId, seatId, { account_id, template, inputs, source_finding }) => {
      const acc = await db.select('agency_accounts',
        `id=eq.${q(account_id)}&agency_id=eq.${q(agencyId)}&select=tenant_id,display_name`, { single: true });
      if (!acc) return null;
      const row = await drafts.create({ tenantId: acc.tenant_id, agencyId, seatId, template, inputs: { ...(inputs || {}), business: (inputs && inputs.business) || acc.display_name }, sourceFinding: source_finding || null });
      await log(agencyId, seatId, 'draft_created', { draft_id: row.id, account_id, template: row.spec.template, name: row.spec.name, copy_source: row.spec.copy && row.spec.copy.source });
      return { ...row, account: acc.display_name, account_id };
    },
    // Edit-before-approve (§5, §11.3): the diff vs the drafted copy is the label.
    editDraft: async (agencyId, seatId, draftId, adGroups) => {
      const d = await db.select('campaign_drafts', `id=eq.${q(draftId)}&agency_id=eq.${q(agencyId)}&select=tenant_id`, { single: true });
      if (!d) return null;
      const r = await drafts.edit({ tenantId: d.tenant_id, draftId, adGroups });
      if (r && r.ok) await log(agencyId, seatId, 'draft_edited', { draft_id: draftId, groups: (adGroups || []).map((g) => g.name) });
      return r;
    },
    draftAction: async (agencyId, seatId, draftId, action) => {
      const d = await db.select('campaign_drafts',
        `id=eq.${q(draftId)}&agency_id=eq.${q(agencyId)}&select=tenant_id,spec`, { single: true });
      if (!d) return null;
      const actor = 'user';
      const r = action === 'approve' ? await drafts.approve({ tenantId: d.tenant_id, draftId, actor, agencyId, seatId })
        : action === 'enable' ? await drafts.enable({ tenantId: d.tenant_id, draftId, actor, agencyId, seatId })
        : action === 'dismiss' ? await drafts.dismiss({ tenantId: d.tenant_id, draftId })
        : { error: `Unknown action ${action}.` };
      if (!r) return null;
      if (!r.error) {
        const ev = { approve: r.status === 'staged' ? 'draft_staged' : 'draft_approved_created_paused', enable: 'draft_enabled', dismiss: 'draft_dismissed' }[action];
        await log(agencyId, seatId, ev, { draft_id: draftId, name: d.spec.name, ...(r.campaign_id ? { campaign_id: r.campaign_id } : {}), ...(r.blockers ? { blockers: r.blockers } : {}) });
      }
      return r;
    },

    // ---- P0: budget pacing + performance targets (agency's OWN operating
    // targets — never client fees; that principle is binding).
    pacing: async (agencyId, nowIso) => {
      const now = nowIso || new Date().toISOString();
      const monthStart = `${now.slice(0, 8)}01`;
      const sevenAgo = new Date(Date.parse(now) - 7 * 86_400_000).toISOString().slice(0, 10);
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=eq.active&select=id,tenant_id,display_name`);
      if (!accounts.length) return [];
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const [targets, spend] = await Promise.all([
        db.select('account_targets', `tenant_id=in.(${ids})&select=*`),
        db.select('spend_daily', `tenant_id=in.(${ids})&date=gte.${q(monthStart)}&select=tenant_id,date,spend_usd,conversions,conversion_value_usd`),
      ]);
      const tByTenant = Object.fromEntries((targets || []).map((t) => [t.tenant_id, t]));
      const rows = accounts.map((a) => {
        const days = (spend || []).filter((s) => s.tenant_id === a.tenant_id);
        const sum = (k, from) => days.filter((s) => !from || s.date >= from).reduce((n, s) => n + Number(s[k] || 0), 0);
        const t = tByTenant[a.tenant_id] || {};
        return {
          account_id: a.id,
          account: a.display_name,
          targets: { monthly_budget_usd: t.monthly_budget_usd || null, cpa_target_usd: t.cpa_target_usd || null, roas_target: t.roas_target || null },
          pacing: pace({ monthlyBudgetUsd: Number(t.monthly_budget_usd) || null, mtdSpendUsd: sum('spend_usd'), last7SpendUsd: sum('spend_usd', sevenAgo), nowIso: now }),
          performance: targetStatus({
            cpaTargetUsd: t.cpa_target_usd != null ? Number(t.cpa_target_usd) : null,
            roasTarget: t.roas_target != null ? Number(t.roas_target) : null,
            spendUsd: sum('spend_usd'), conversions: sum('conversions'), conversionValueUsd: sum('conversion_value_usd'),
          }),
        };
      });
      return sortPacing(rows);
    },
    setTargets: async (agencyId, seatId, accountId, patch) => {
      const acc = await db.select('agency_accounts',
        `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}&select=tenant_id`, { single: true });
      if (!acc) return null;
      const row = {
        tenant_id: acc.tenant_id,
        monthly_budget_usd: patch.monthly_budget_usd != null ? patch.monthly_budget_usd : null,
        cpa_target_usd: patch.cpa_target_usd != null ? patch.cpa_target_usd : null,
        roas_target: patch.roas_target != null ? patch.roas_target : null,
        set_by: seatId, updated_at: new Date().toISOString(),
      };
      await db.upsert('account_targets', [row], 'tenant_id');
      await log(agencyId, seatId, 'targets_set', { account_id: accountId, ...patch });
      return row;
    },

    // ---- P0: alert stream (daily digest renders from the same rows).
    alertsFor: async (agencyId) => {
      const accounts = await db.select('agency_accounts',
        `agency_id=eq.${q(agencyId)}&status=in.(pending,active)&select=tenant_id,display_name`);
      if (!accounts.length) return [];
      const nameByTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a.display_name]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('alerts',
        `tenant_id=in.(${ids})&select=id,tenant_id,severity,kind,title,detail,campaign_ref,created_at,acked_at,acked_seat:agency_seats(name)&order=created_at.desc&limit=100`);
      return rows.map((r) => ({ ...r, account: nameByTenant[r.tenant_id] }));
    },
    ackAlert: async (agencyId, seatId, alertId) => {
      await db.update('alerts', `id=eq.${q(alertId)}`, { acked_by: seatId, acked_at: new Date().toISOString() });
      await log(agencyId, seatId, 'alert_acked', { alert_id: alertId });
    },

    // ---- P0: triage snooze + batch approval. Batch logs every id
    // individually — the audit trail never compresses.
    snoozeChange: async (agencyId, seatId, changeId, days, reason) => {
      const until = new Date(Date.now() + (days || 7) * 86_400_000).toISOString();
      await db.update('changes', `id=eq.${q(changeId)}`, { snoozed_until: until, snoozed_by: seatId, snooze_reason: reason || null });
      await log(agencyId, seatId, 'change_snoozed', { change_id: changeId, days: days || 7, reason: reason || null });
      return { until };
    },
    approveBatch: async (agencyId, seatId, changeIds) => {
      let n = 0;
      for (const id of changeIds || []) {
        await db.update('changes', `id=eq.${q(id)}`, { status: 'approved' });
        await log(agencyId, seatId, 'change_approved', { change_id: id, batch: true });
        n += 1;
      }
      return { approved: n };
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
      const full = await db.select('changes', `id=eq.${q(changeId)}&select=tenant_id,finding_id,finding:findings(rule_id)`, { single: true }).catch(() => null);
      if (full) {
        await require('../../shared/src/telemetry').createTelemetry({ db }).dismissal({
          tenantId: full.tenant_id, changeId, findingId: full.finding_id, ruleId: full.finding ? full.finding.rule_id : null,
          reasonTap: reason, actor: `seat:${seatId}`,
        });
      }
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
