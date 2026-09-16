// Store adapters - the real Supabase implementations of every store contract
// the apps consume. One factory per consumer, all over one PostgREST client.
// Contracts are defined by the consumers (apps/worker/src/*, apps/web/src/*,
// packages/tools/src/executor.js, packages/billing/src/webhooks.js) - these
// adapters exist to satisfy them against the deployed §1 schema.

const q = (s) => encodeURIComponent(s);
const { accessFrom, autopilotAllowed, planIsActive } = require('../../billing/src/access');
const createTelemetryBeat = (db, stream) => require('../../shared/src/telemetry').createTelemetry({ db }).beat(stream);

// ---------------------------------------------------------------- worker
// A tenant looked after by an agency (agency plan moves 9 to 11): who to
// email, whether reports wait for review, how the client's own app behaves.
// Null when the tenant is not managed. Paused accounts still count as managed.
async function managedBy(db, tenantId) {
  if (!tenantId) return null;
  const acc = await db.select('agency_accounts', `tenant_id=eq.${q(tenantId)}&status=in.(active,paused)&select=id,agency_id,seat_id,review_reports,client_mode,client_copy,display_name,agency:agencies(name,timezone,notify_email),seat:agency_seats(email,name,status)&limit=1`, { single: true }).catch(() => null);
  if (!acc) return null;
  let to = acc.seat && acc.seat.status === 'active' ? acc.seat.email : null;
  if (!to) to = acc.agency && acc.agency.notify_email ? acc.agency.notify_email : null;
  if (!to) {
    const admin = await db.select('agency_seats', `agency_id=eq.${q(acc.agency_id)}&role=eq.admin&status=eq.active&select=email&order=created_at.asc&limit=1`, { single: true }).catch(() => null);
    to = admin ? admin.email : null;
  }
  const kit = await db.select('brand_kits', `agency_id=eq.${q(acc.agency_id)}&select=display_name,logo_light_url,color_primary,footer_text&order=version.desc&limit=1`, { single: true }).catch(() => null);
  return {
    account_id: acc.id, agency_id: acc.agency_id, display_name: acc.display_name,
    agency_name: (acc.agency && acc.agency.name) || 'Your agency',
    brand: kit ? { name: kit.display_name || ((acc.agency && acc.agency.name) || null), logo_url: kit.logo_light_url || null, color_primary: kit.color_primary || null, footer_text: kit.footer_text || null } : null,
    timezone: (acc.agency && acc.agency.timezone) || 'Asia/Dubai',
    review_reports: acc.review_reports !== false,
    client_mode: acc.client_mode || 'shared',
    client_copy: !!acc.client_copy,
    to,
  };
}

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
        // applying a change - either it fixed itself or the owner fixed it.
        await db.insert('ledger', resolved.map((r) => ({
          tenant_id: tenantId, event: 'finding_resolved', actor: 'system',
          summary_text: `${r.title ? `"${r.title}"` : r.rule_id.replace(/[._]/g, ' ')} is no longer showing up - it fixed itself or you fixed it. We noticed.`,
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
    managedBy: (tenantId) => managedBy(db, tenantId),
    saveReport: async (runId, { id = null, html_email, html_web, findings_snapshot, tenant_id, type, summary = null, review_status = null }) => {
      // Once the audit fee is paid every later report is born unlocked.
      const paid = await db.select('payments', `tenant_id=eq.${q(tenant_id)}&kind=in.(audit_unlock,large_audit,setup_bundle)&refunded_at=is.null&select=id&limit=1`, { single: true }).catch(() => null);
      const rows = await db.insert('reports', [{
        ...(id ? { id } : {}),
        run_id: runId, tenant_id, type: type || 'weekly',
        html_email, html_web, findings_snapshot: findings_snapshot || [], summary,
        ...(review_status ? { review_status } : {}),
        ...(paid ? { unlocked: true, unlocked_at: new Date().toISOString() } : {}),
      }]);
      return (rows && rows[0] && rows[0].id) || id || null;
    },
    tenantPaid: async (tenantId) => !!(await db.select('payments', `tenant_id=eq.${q(tenantId)}&kind=in.(audit_unlock,large_audit,setup_bundle)&refunded_at=is.null&select=id&limit=1`, { single: true }).catch(() => null)),
    // The band sets itself (fix plan move 11): from search-term count and spend.
    setSizeBand: async (tenantId, band) => {
      if (!['4k', '10k', '25k'].includes(band)) return false;
      const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=size_band`, { single: true }).catch(() => null);
      if (t && t.size_band === band) return false;
      await db.update('tenants', `id=eq.${q(tenantId)}`, { size_band: band }).catch(() => {});
      return true;
    },
    // The one-tap links a report email carries (fix plan move 4): single-use,
    // signed-in on redemption, minted before the email is rendered so the
    // HTML can carry them. Report id is chosen up front for the same reason.
    mintReportLinks: async (tenantId, reportId, { baseUrl, now = Date.now(), pendingCount = 0 } = {}) => {
      const { mintLink } = require('../../emails/src/magic-links');
      const inserts = [];
      const linkStore = { insertLink: (row) => { inserts.push(db.insert('magic_links', [row], { returning: false })); } };
      const view = mintLink({ tenantId, purpose: 'view_report', targetId: reportId, baseUrl, now }, linkStore);
      const approve = pendingCount > 0 ? mintLink({ tenantId, purpose: 'approve_all', targetId: reportId, baseUrl, now }, linkStore) : null;
      await Promise.all(inserts);
      return { view_url: view.url, approve_url: approve ? approve.url : null, settings_url: `${baseUrl}/app/settings` };
    },
    // Queue the email for a finished report (fix plan move 4). The first audit
    // sends audit_ready; every later report sends its own frozen HTML on the
    // report stream, which the drain suppresses when reports are switched off.
    notifyReport: async ({ tenantId, reportId, type, summary = null, issueCount = 0, pendingCount = 0, links = {}, currencySymbol = '$', managed = null, baseUrl = 'https://app.tryinsyt.com' }) => {
      const [owner, tenant] = await Promise.all([
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=email&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=website_url,email_reports`, { single: true }).catch(() => null),
      ]);
      // Emails go to the agency (agency plan move 10): the report to the
      // assigned seat, and a plain copy to the client only when asked for.
      if (managed && managed.to) {
        const s0 = summary || {};
        const waste0 = s0.waste_monthly_usd != null && Number(s0.waste_monthly_usd) > 0 ? `${currencySymbol}${Math.round(Number(s0.waste_monthly_usd)).toLocaleString('en-US')}` : null;
        const headline0 = waste0 ? `about ${waste0} a month going to waste` : issueCount > 0 ? `${issueCount} finding${issueCount === 1 ? '' : 's'}` : 'all clear';
        const consoleUrl = `${baseUrl}/app/agency/accounts/${managed.account_id}`;
        await db.insert('emails', [{
          tenant_id: tenantId, report_id: reportId, template_id: type === 'deep' ? 'report_deep' : 'report_weekly', to_email: managed.to, stream: 'report', status: 'queued',
          payload: { subject: `${managed.display_name}: ${type === 'signup' ? 'first audit ready' : type === 'deep' ? 'deep review ready' : headline0}${managed.review_reports ? ' (held for your review)' : ''}`, pending_count: pendingCount, report_url: consoleUrl, approve_url: '', agency: true },
        }], { returning: false });
        if (managed.client_copy && owner && owner.email) {
          await db.insert('emails', [{
            tenant_id: tenantId, template_id: 'report_ready_copy', to_email: owner.email, stream: 'report', status: 'queued',
            payload: { site: (tenant && tenant.website_url) || managed.display_name, agency: managed.agency_name, report_url: `${baseUrl}/app/report/${reportId}`, held: managed.review_reports },
          }], { returning: false });
        }
        return { queued: true, template: 'agency_report', to: managed.to };
      }
      if (!owner || !owner.email) return { queued: false, reason: 'no owner email' };
      const s = summary || {};
      const waste = s.waste_monthly_usd != null && Number(s.waste_monthly_usd) > 0 ? `${currencySymbol}${Math.round(Number(s.waste_monthly_usd)).toLocaleString('en-US')}` : null;
      if (type === 'signup') {
        await db.insert('emails', [{
          tenant_id: tenantId, report_id: reportId, template_id: 'audit_ready', to_email: owner.email, stream: 'transactional', status: 'queued',
          payload: {
            issue_count: issueCount, site: (tenant && tenant.website_url) || 'your website',
            health_score: s.health_score != null ? Math.round(Number(s.health_score)) : '',
            waste_monthly: waste || '', report_url: links.view_url || '',
          },
        }], { returning: false });
        return { queued: true, template: 'audit_ready' };
      }
      const headline = waste ? `about ${waste} a month going to waste` : issueCount > 0 ? `${issueCount} finding${issueCount === 1 ? '' : 's'}` : 'all clear';
      await db.insert('emails', [{
        tenant_id: tenantId, report_id: reportId, template_id: type === 'deep' ? 'report_deep' : 'report_weekly', to_email: owner.email, stream: 'report', status: 'queued',
        payload: { subject: type === 'deep' ? 'Your deep review is ready' : `This week: ${headline}`, pending_count: pendingCount, report_url: links.view_url || '', approve_url: links.approve_url || '' },
      }], { returning: false });
      return { queued: true, template: 'report' };
    },
    // Snapshot stage (§6.3/6.4/§11.3): campaigns + spend_daily + asset
    // labels, refreshed by every run so pacing, the spend card and the
    // creative loop read stored data - never live Google calls.
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
      const [auto, exc, open, recent, reverted, budgetMoves, camps, sub] = await Promise.all([
        db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }).catch(() => null),
        db.select('standing_exceptions', `tenant_id=eq.${q(tenantId)}&cleared_at=is.null&select=change_key,target`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=in.(proposed,approved)&select=target`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.applied&applied_at=gte.${q(since30)}&select=change_key`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.reverted&applied_at=gte.${q(since30)}&select=id`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&tool_id=eq.ads.adjust_budget&status=eq.applied&applied_at=gte.${q(since7)}&select=params`).catch(() => []),
        db.select('campaigns', `tenant_id=eq.${q(tenantId)}&status=eq.enabled&select=google_campaign_id,budget_daily_usd`).catch(() => []),
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,status&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
      ]);
      // Autopilot is a plan feature (gated-platform spec §2): the categories
      // only count on an active Autopilot or Scale plan. Everything else
      // becomes a card that waits for a tap.
      const cats = autopilotAllowed(sub) ? ((auto && auto.categories) || {}) : {};
      const dailyTotal = (camps || []).reduce((s, c) => s + Number(c.budget_daily_usd || 0), 0) || 1;
      const weeklyDelta = (budgetMoves || []).reduce((s, c) => s + Math.abs(Number((c.params || {}).new_daily_usd || 0) - Number((c.params || {}).previous_daily_usd || 0)), 0) / dailyTotal * 100;
      const campMap = new Map((camps || []).map((c) => [String(c.google_campaign_id), { budget_daily_usd: Number(c.budget_daily_usd || 0) }]));
      return {
        autopilot: { negatives: cats.negatives === true || cats.negatives === 'auto', budgets: cats.budgets === true || cats.budgets === 'auto', counting: cats.counting === true || cats.counting === 'auto' },
        fences: new Set((exc || []).filter((e) => e.change_key && e.change_key.startsWith('fence:') && e.target).map((e) => e.target)),
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
      // Tracking breakage: the one auto-revert (§9.3) - money protection.
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
    // "Against your goals" report section - non-null only when targets are
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
    // Report unlocked: a line in History and the receipt email with the report link.
    unlockReceipt: async (tenantId, { amountUsd = 0, kind = 'audit_unlock', email = null } = {}) => {
      const [owner, report] = await Promise.all([
        db.select('users', `tenant_id=eq.${q(tenantId)}&role=eq.owner&select=email&limit=1`, { single: true }).catch(() => null),
        db.select('reports', `tenant_id=eq.${q(tenantId)}&select=id&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
      ]);
      const amount = `$${Number(amountUsd || 0).toLocaleString('en-US')}`;
      await db.insert('ledger', [{ tenant_id: tenantId, event: 'subscription_changed', actor: 'user', summary_text: amountUsd > 0 ? `Your full report is unlocked. ${amount} paid, credited to your first month if you start a plan.` : 'Your full report is unlocked, at no charge.' }], { returning: false }).catch(() => {});
      const to = (owner && owner.email) || email;
      if (!to) return { queued: false };
      const base = process.env.APP_BASE_URL || 'https://app.tryinsyt.com';
      await db.insert('emails', [{ tenant_id: tenantId, template_id: 'unlock_receipt', to_email: to, stream: 'transactional', status: 'queued', payload: { amount, kind, report_url: report ? `${base}/app/report/${report.id}` : `${base}/app` } }], { returning: false }).catch(() => {});
      return { queued: true };
    },
    upsertSubscription: async (row) => { await db.upsert('subscriptions', [row], 'stripe_subscription_id'); },
    markSubscription: async (stripeSubId, patch) => {
      await db.update('subscriptions', `stripe_subscription_id=eq.${q(stripeSubId)}`, patch);
    },
    recordPayment: async (row) => {
      // Stripe retries: a second delivery of the same session is not an error.
      try { await db.insert('payments', [row], { returning: false }); } catch (e) { if (!/duplicate|23505|409/.test(String(e && e.message))) throw e; }
      // The $20 (or large-account) audit fee unlocks every report the tenant
      // has and will have: reports are rendered locked, the flag opens them.
      if (['audit_unlock', 'large_audit', 'setup_bundle'].includes(row.kind)) {
        await db.update('reports', `tenant_id=eq.${q(row.tenant_id)}`, { unlocked: true, unlocked_at: new Date().toISOString() }).catch(() => {});
      }
    },
    ledger: async (entry) => { await db.insert('ledger', [entry], { returning: false }); },
    audit: async (entry) => { await db.insert('audit_log', [entry], { returning: false }); },
    // Spec §6: the fix the customer tapped before subscribing is approved by
    // the webhook itself, so a closed tab never loses it. Proposed rows only.
    markRefunded: async (paymentIntent) => {
      const rows = await db.update('payments', `stripe_payment_intent=eq.${q(paymentIntent)}`, { refunded_at: new Date().toISOString() }).catch(() => []);
      return rows && rows[0] ? { tenant_id: rows[0].tenant_id } : null;
    },
    markCredited: async (tenantId) => {
      await db.update('payments', `tenant_id=eq.${q(tenantId)}&credited_to_subscription=eq.false`, { credited_to_subscription: true }).catch(() => {});
    },
    approveOnCheckout: async (tenantId, changeId) => {
      const ch = await db.select('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&select=id,status`, { single: true }).catch(() => null);
      if (!ch || ch.status !== 'proposed') return false;
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&status=eq.proposed`, { status: 'approved' });
      await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: changeId, channel: 'dashboard' }], { returning: false }).catch(() => {});
      return true;
    },
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
    // The first agency (fix plan move 14): this tenant's owner becomes its admin seat.
    createAgencyForTenant: async (tenantId, name) => {
      const owner = await db.select('users', `tenant_id=eq.${q(tenantId)}&role=eq.owner&select=email,name,google_sub`, { single: true }).catch(() => null);
      if (!owner) return { ok: false, error: 'No owner user on that tenant.' };
      const [agency] = await db.insert('agencies', [{ name: String(name || owner.email).slice(0, 120) }]);
      await db.insert('agency_seats', [{ agency_id: agency.id, email: owner.email, name: owner.name || null, google_sub: owner.google_sub, tenant_id: tenantId, role: 'admin', status: 'active' }], { returning: false });
      // The welcome (agency plan move 12): the console link, in the inbox, the moment the agency exists.
      await db.insert('emails', [{ tenant_id: tenantId, template_id: 'agency_welcome', to_email: owner.email, stream: 'transactional', status: 'queued', payload: { agency: agency.name || name, name: owner.name || '', console_url: 'https://app.tryinsyt.com/app/agency' } }], { returning: false }).catch(() => {});
      return { ok: true, agency_id: agency.id };
    },
    // A pending client account becomes active the moment its Google login has linked something.
    activatePendingAgencyAccounts: async () => {
      const pending = await db.select('agency_accounts', 'status=eq.pending&select=id,tenant_id').catch(() => []);
      const out = [];
      for (const a of pending || []) {
        const linked = await db.select('assets', `tenant_id=eq.${q(a.tenant_id)}&linked=eq.true&select=id&limit=1`, { single: true }).catch(() => null);
        if (!linked) continue;
        await db.update('agency_accounts', `id=eq.${q(a.id)}`, { status: 'active' }).catch(() => {});
        out.push(a.id);
      }
      return out;
    },
    // The morning digest (agency plan move 10): once a day at 8am in the
    // agency's timezone, one email per active seat listing unacknowledged
    // alerts and reports awaiting review on the accounts that seat can see.
    // Nothing is sent when there is nothing. Idempotent per seat per day.
    agencyDigests: async (nowIso, { baseUrl = 'https://app.tryinsyt.com' } = {}) => {
      const now = new Date(nowIso || new Date().toISOString());
      const agencies = await db.select('agencies', 'status=eq.active&select=id,name,timezone').catch(() => []);
      const sent = [];
      for (const ag of agencies || []) {
        const tz = ag.timezone || 'Asia/Dubai';
        let hour; let day;
        try {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
          const get = (t) => (parts.find((p) => p.type === t) || {}).value;
          hour = Number(get('hour')); day = `${get('year')}-${get('month')}-${get('day')}`;
        } catch { hour = now.getUTCHours(); day = now.toISOString().slice(0, 10); }
        if (hour !== 8) continue;
        const [seats, accounts] = await Promise.all([
          db.select('agency_seats', `agency_id=eq.${q(ag.id)}&status=eq.active&select=id,email,name,role,tenant_id`).catch(() => []),
          db.select('agency_accounts', `agency_id=eq.${q(ag.id)}&status=eq.active&select=id,tenant_id,display_name,seat_id`).catch(() => []),
        ]);
        if (!(seats || []).length || !(accounts || []).length) continue;
        const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
        const [alerts, reports] = await Promise.all([
          db.select('alerts', `tenant_id=in.(${ids})&acked_at=is.null&select=tenant_id,title,severity,created_at&order=created_at.desc&limit=200`).catch(() => []),
          db.select('reports', `tenant_id=in.(${ids})&review_status=eq.pending&select=tenant_id,created_at`).catch(() => []),
        ]);
        if (!(alerts || []).length && !(reports || []).length) continue;
        const nameOf = Object.fromEntries(accounts.map((a) => [a.tenant_id, a.display_name]));
        for (const seat of seats) {
          if (!seat.email || !seat.tenant_id) continue;
          const mine = seat.role === 'am' ? new Set(accounts.filter((a) => !a.seat_id || a.seat_id === seat.id).map((a) => a.tenant_id)) : null;
          const myAlerts = (alerts || []).filter((a) => !mine || mine.has(a.tenant_id));
          const myReports = (reports || []).filter((r) => !mine || mine.has(r.tenant_id));
          if (!myAlerts.length && !myReports.length) continue;
          const already = await db.select('emails', `template_id=eq.agency_digest&to_email=eq.${q(seat.email)}&created_at=gte.${q(`${day}T00:00:00Z`)}&select=id&limit=1`, { single: true }).catch(() => null);
          if (already) continue;
          const lines = [
            ...myAlerts.slice(0, 12).map((a) => `${nameOf[a.tenant_id] || 'An account'}: ${a.title}`),
            ...myReports.map((r) => `${nameOf[r.tenant_id] || 'An account'}: weekly report waiting for your review`),
          ];
          await db.insert('emails', [{ tenant_id: seat.tenant_id, template_id: 'agency_digest', to_email: seat.email, stream: 'transactional', status: 'queued', payload: { agency: ag.name, name: seat.name || '', alerts: myAlerts.length, reviews: myReports.length, lines, console_url: `${baseUrl}/app/agency/alerts` } }], { returning: false }).catch(() => {});
          sent.push(seat.email);
        }
      }
      return sent;
    },
    // Orphan shells (agency plan move 6): an account removed 30 days ago whose
    // tenant never had a user or an asset is deleted; nothing was ever there.
    retireOrphanShells: async (nowIso) => {
      const cutoff = new Date(Date.parse(nowIso || new Date().toISOString()) - 30 * 86_400_000).toISOString();
      const rows = await db.select('agency_accounts', `status=eq.removed&removed_at=lt.${q(cutoff)}&select=id,tenant_id`).catch(() => []);
      const out = [];
      for (const a of rows || []) {
        const [user, asset] = await Promise.all([
          db.select('users', `tenant_id=eq.${q(a.tenant_id)}&select=id&limit=1`, { single: true }).catch(() => null),
          db.select('assets', `tenant_id=eq.${q(a.tenant_id)}&select=id&limit=1`, { single: true }).catch(() => null),
        ]);
        if (user || asset) continue;
        await db.rpc('delete_tenant', { p_tenant: a.tenant_id }).catch(() => {}); // removes the agency_accounts row too
        out.push(a.tenant_id);
      }
      return out;
    },
    // Four ops buttons (fix plan move 15): so nobody writes SQL against production again.
    tenantDetail: async (tenantId) => {
      const [tenant, assets, users, notice] = await Promise.all([
        db.select('tenants', `id=eq.${q(tenantId)}&select=*`, { single: true }),
        db.select('assets', `tenant_id=eq.${q(tenantId)}&select=id,kind,external_id,display_name,linked,metadata&order=kind.asc`).catch(() => []),
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=id,email,role,google_sub`).catch(() => []),
        db.select('platform_notices', 'active=eq.true&select=id,text&order=created_at.desc&limit=1', { single: true }).catch(() => null),
      ]);
      return { tenant, assets: assets || [], users: users || [], notice };
    },
    linkAsset: async (tenantId, assetId, linked = true) => {
      const row = await db.select('assets', `id=eq.${q(assetId)}&tenant_id=eq.${q(tenantId)}&select=id,metadata`, { single: true }).catch(() => null);
      if (!row) return false;
      await db.update('assets', `id=eq.${q(assetId)}`, { linked: !!linked, metadata: { ...(row.metadata || {}), matched_via: linked ? 'ops' : null } });
      return true;
    },
    mergeTenants: async (fromId, toId) => {
      if (!fromId || !toId || fromId === toId) return { ok: false };
      // People and their Google connection move; the empty shell is cancelled, never deleted here.
      await db.update('users', `tenant_id=eq.${q(fromId)}`, { tenant_id: toId, role: 'viewer' });
      await db.update('tenants', `id=eq.${q(fromId)}`, { status: 'cancelled' });
      await db.insert('audit_log', [{ tenant_id: toId, event: 'tenants_merged', detail: { from: fromId } }], { returning: false }).catch(() => {});
      return { ok: true };
    },
    deleteTenant: async (tenantId) => { await db.rpc('delete_tenant', { p_tenant: tenantId }); return { ok: true }; },
    setNotice: async (text) => {
      await db.update('platform_notices', 'active=eq.true', { active: false }).catch(() => {});
      const t = String(text || '').trim().slice(0, 240);
      if (t) await db.insert('platform_notices', [{ text: t, active: true }], { returning: false });
      return { ok: true, text: t || null };
    },
    activeNotice: async () => {
      const n = await db.select('platform_notices', 'active=eq.true&select=text&order=created_at.desc&limit=1', { single: true }).catch(() => null);
      return n ? n.text : null;
    },
    // Pauses end by themselves (fix plan move 13).
    resumeDue: async (nowIso) => {
      const rows = await db.select('tenants', `status=eq.paused&paused_until=lt.${q(nowIso)}&select=id`).catch(() => []);
      for (const t of rows || []) await db.update('tenants', `id=eq.${q(t.id)}`, { status: 'active', paused_until: null }).catch(() => {});
      return (rows || []).map((t) => t.id);
    },
    // The $20 tail (fix plan move 13): four weekly reports without a plan,
    // then monthly. Returns 'weekly' | 'monthly' and whether a run is due now.
    weeklyCadence: async (tenantId, now = Date.now()) => {
      const sub = await db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&status=in.(active,past_due,trialing)&select=id&limit=1`, { single: true }).catch(() => null);
      if (sub) return { cadence: 'weekly', due: true };
      // Managed tenants ride the agency's tier (agency plan move 11): never the monthly tail.
      if (await managedBy(db, tenantId)) return { cadence: 'weekly', due: true };
      const reports = await db.select('reports', `tenant_id=eq.${q(tenantId)}&type=eq.weekly&select=created_at&order=created_at.desc&limit=4`).catch(() => []);
      if (!reports || reports.length < 4) return { cadence: 'weekly', due: true };
      const last = Date.parse(reports[0].created_at);
      return { cadence: 'monthly', due: now - last >= 27 * 86_400_000 };
    },
    dueWatches: async (nowIso) => db.select('watches', `status=eq.active&select=*&or=(last_check_at.is.null,last_check_at.lt.${q(nowIso)})`),
    patchWatch: async (id, patch) => { await db.update('watches', `id=eq.${q(id)}`, patch); },
    connectionsForSweep: async () => db.select('google_connections', 'select=id,user_id,status,last_validated_at'),
  };
}

// ---------------------------------------------------------------- dashboard (§11 screens)
// Consumed by apps/web server routes. healthScore comes from the rules
// package so the dial always matches the report's number.
// In shared mode the client's own actions land in the agency trail (agency plan move 11).
async function mirrorToAgency(db, tenantId, event, detail) {
  const m = await managedBy(db, tenantId);
  if (!m) return;
  await db.insert('agency_audit_log', [{ agency_id: m.agency_id, seat_id: null, event, detail: { ...detail, account_id: m.account_id, by: 'client' } }], { returning: false }).catch(() => {});
}

function dashStore(db, deps = {}) {
  const mirrorToAgencyBound = (tenantId, event, detail) => mirrorToAgency(db, tenantId, event, detail).catch(() => {});
  const { healthScore } = require('../../rules/src/engine');
  const { createTelemetry } = require('../../shared/src/telemetry');
  const { createDraftService } = require('../../campaigns/src/service');
  const { renderPlain } = require('../../campaigns/src/builder');
  const tel = createTelemetry({ db });
  const draftsSvc = createDraftService({ db, google: deps.google || null, model: deps.model || null, modelId: deps.modelId || null });
  const plainDraft = (d) => ({ id: d.id, status: d.status, template: d.template, plain: renderPlain(d.spec), gates: d.spec.gates || null, budget_daily_usd: d.spec.budget_daily_usd, name: d.spec.name, ad_groups: d.spec.ad_groups.map((g) => ({ name: g.name, rsa: g.rsa })), created_at: d.created_at });
  const store = {
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
    // snapshot lands - the card simply does not render.
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
    // Home overview (richer-platform spec §2, §8): the money strip, the
    // week's story, the three accounts, alerts and the 28-day series, in one
    // round trip. Every query is tenant-scoped and single-table (no PostgREST
    // subqueries, the 31 Aug settings bug).
    overview: async (tenantId, now = new Date()) => {
      const nowMs = now.getTime();
      const iso = (ms) => new Date(ms).toISOString();
      const day28 = iso(nowMs - 28 * 86_400_000).slice(0, 10);
      const ago7 = iso(nowMs - 7 * 86_400_000);
      const ago28 = iso(nowMs - 28 * 86_400_000);
      const [days, report, cum, applied, runs, assets, owner, alerts, fixes, spend, approvedWaiting] = await Promise.all([
        db.select('spend_daily', `tenant_id=eq.${q(tenantId)}&date=gte.${q(day28)}&select=date,spend_usd,conversions,conversion_value_usd&order=date.asc`).catch(() => []),
        db.select('reports', `tenant_id=eq.${q(tenantId)}&select=id,created_at,summary,findings_snapshot&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
        db.select('ledger_cumulative', `tenant_id=eq.${q(tenantId)}`, { single: true }).catch(() => null),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.applied&applied_at=gte.${q(ago7)}&select=id,changeset_id,applied_at`).catch(() => []),
        db.select('runs', `tenant_id=eq.${q(tenantId)}&status=in.(complete,degraded)&select=id,type,status,finished_at&order=finished_at.desc.nullslast&limit=8`).catch(() => []),
        db.select('assets', `tenant_id=eq.${q(tenantId)}&linked=eq.true&kind=in.(ads_account,ga4_property,gtm_container)&select=kind,external_id,display_name`).catch(() => []),
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=id&limit=1`, { single: true }).catch(() => null),
        db.select('alerts', `tenant_id=eq.${q(tenantId)}&created_at=gte.${q(ago7)}&select=id,severity,kind,title,created_at,acked_at&order=created_at.desc&limit=10`).catch(() => []),
        db.select('ledger', `tenant_id=eq.${q(tenantId)}&event=eq.fix_applied&created_at=gte.${q(ago28)}&select=summary_text,created_at&order=created_at.asc`).catch(() => []),
        store.spendPosition(tenantId, now).catch(() => null),
        // Approved but not yet applied (fix plan move 5): Home says why when it drags.
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.approved&select=id,tool_id,created_at&order=created_at.asc`).catch(() => []),
      ]);
      // Open or failed checks and what the site carries (fix plan moves 3 and 8).
      const [openRuns, tenantRow] = await Promise.all([
        db.select('runs', `tenant_id=eq.${q(tenantId)}&status=in.(queued,running,failed)&select=id,type,status,started_at,finished_at&order=started_at.desc.nullslast&limit=3`).catch(() => []),
        db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true }).catch(() => null),
      ]);
      let siteTags = null;
      if (tenantRow && tenantRow.website_url) {
        let host = null;
        try { host = new URL(tenantRow.website_url.startsWith('http') ? tenantRow.website_url : `https://${tenantRow.website_url}`).hostname; } catch { host = null; }
        if (host) {
          const c = await db.select('crawls', `url=ilike.*${q(host)}*&status=eq.complete&select=tags_found&order=created_at.desc&limit=1`, { single: true }).catch(() => null);
          siteTags = (c && c.tags_found) || null;
        }
      }
      const changesetIds = [...new Set((applied || []).map((c) => c.changeset_id).filter(Boolean))];
      const [conn, watches] = await Promise.all([
        owner ? db.select('google_connections', `user_id=eq.${q(owner.id)}&select=status&limit=1`, { single: true }).catch(() => null) : null,
        changesetIds.length
          ? db.select('watches', `tenant_id=eq.${q(tenantId)}&kind=eq.changeset_verify&target_id=in.(${changesetIds.map(q).join(',')})&select=target_id,status`).catch(() => [])
          : [],
      ]);

      const summary = (report && report.summary) || {};
      const counts = summary.counts || null;
      const findingsCount = counts
        ? Object.values(counts).reduce((s, n) => s + Number(n || 0), 0)
        : ((report && report.findings_snapshot) || []).length;
      const finished = (runs || []).filter((r) => r.finished_at);
      const lastRun = finished[0] || null;
      // Weekly checks run in the Sunday window, Gulf time (journeys/scheduling).
      const localDow = new Date(nowMs + 4 * 3600_000).getUTCDay();
      const nextCheckDays = localDow === 0 ? 0 : 7 - localDow;

      const watchState = new Map((watches || []).map((w) => [w.target_id, w.status]));
      const week = { applied: 0, verified: 0, watching: 0, reverted: 0 };
      for (const c of applied || []) {
        week.applied += 1;
        const st = watchState.get(c.changeset_id);
        if (st === 'resolved') week.verified += 1;
        else if (st === 'triggered') week.reverted += 1;
        else week.watching += 1;
      }

      const LABEL = { ads_account: 'Google Ads', ga4_property: 'Analytics', gtm_container: 'Tag Manager' };
      const HREF = { ads_account: '/app/connected', ga4_property: '/app/connected/analytics', gtm_container: '/app/connected/tag-manager' };
      const connOk = !!(conn && conn.status === 'valid');
      // Three states for a door we could not match: the site does not carry
      // it (unused, neutral), or it does and this login cannot see it or we
      // could not match it (unmatched, a warning with a way to choose).
      const onSite = { gtm_container: !!(siteTags && (siteTags.gtm_containers || []).length), ga4_property: !!(siteTags && (siteTags.ga4_ids || []).length), ads_account: true };
      const accounts = ['ads_account', 'ga4_property', 'gtm_container'].map((kind) => {
        const a = (assets || []).find((x) => x.kind === kind) || null;
        return {
          kind,
          label: LABEL[kind],
          href: HREF[kind],
          name: a ? (a.display_name || a.external_id) : null,
          external_id: a ? a.external_id : null,
          status: !a ? (siteTags && !onSite[kind] ? 'unused' : 'unmatched') : (connOk ? 'ok' : 'reconnect'),
          read_at: a && lastRun ? lastRun.finished_at : null,
        };
      });
      const seen = (siteTags && siteTags.seen) || {};
      const openRun = (openRuns || []).find((r) => r.status === 'queued' || r.status === 'running') || null;
      const failedRun = !openRun && (openRuns || []).find((r) => r.status === 'failed') || null;

      const waitingRows = approvedWaiting || [];
      const notice = await db.select('platform_notices', 'active=eq.true&select=text&order=created_at.desc&limit=1', { single: true }).catch(() => null);
      // Return on ad spend (fix plan move 11): only when order values exist.
      const spend28 = (days || []).reduce((s, d) => s + Number(d.spend_usd || 0), 0);
      const value28 = (days || []).reduce((s, d) => s + Number(d.conversion_value_usd || 0), 0);
      const roas = value28 > 0 && spend28 > 0 ? { spend_28d_usd: Math.round(spend28), value_28d_usd: Math.round(value28), ratio: Math.round((value28 / spend28) * 10) / 10 } : null;
      return {
        spend: spend || null,
        notice: notice ? notice.text : null,
        roas,
        running: openRun ? { since: openRun.started_at || null, type: openRun.type } : null,
        failed_last: !!(failedRun && !lastRun) || !!(failedRun && lastRun && failedRun.started_at && lastRun.finished_at && failedRun.started_at > lastRun.finished_at),
        site: {
          consent_tool: seen.consent_tool || null,
          other_tools: seen.other_tools || [],
          whatsapp: !!(seen.contact && seen.contact.whatsapp),
          phone: !!(seen.contact && seen.contact.phone),
          server_side_gtm: !!seen.server_side_gtm,
        },
        waiting: {
          approved: waitingRows.length,
          oldest_at: waitingRows.length ? waitingRows[0].created_at : null,
          needs_fix_access: waitingRows.some((c) => c.tool_id && !/^(ads|settings)\./.test(c.tool_id)),
        },
        waste_monthly_usd: summary.waste_monthly_usd != null ? Math.round(Number(summary.waste_monthly_usd)) : null,
        recovered: { fixes: Number((cum && cum.fixes_applied) || 0), usd: Math.round(Number((cum && cum.waste_removed_usd) || 0)) },
        this_week: {
          last_check_at: lastRun ? lastRun.finished_at : null,
          last_check_type: lastRun ? lastRun.type : null,
          findings: report ? findingsCount : null,
          next_check_days: nextCheckDays,
          ...week,
        },
        accounts,
        alerts: (alerts || [])
          .map((a) => ({ id: a.id, severity: a.severity, kind: a.kind, title: a.title, at: a.created_at, acked: !!a.acked_at }))
          .sort((x, y) => Number(x.acked) - Number(y.acked)),
        performance: {
          days: (days || []).map((d) => ({ date: d.date, spend_usd: Number(d.spend_usd || 0), conversions: Number(d.conversions || 0) })),
          checks: finished.map((r) => r.finished_at),
          fixes: (fixes || []).map((f) => ({ at: f.created_at, title: f.summary_text })),
        },
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
    // The gate (gated-platform spec §1): locked / unlocked / active plus the
    // customer's own numbers, so every gated state speaks in their figures.
    access: async (tenantId) => {
      const [paid, sub, tenant, pricing, report, pending, ads, owner] = await Promise.all([
        db.select('payments', `tenant_id=eq.${q(tenantId)}&kind=in.(audit_unlock,large_audit,setup_bundle)&refunded_at=is.null&select=id,kind,refunded_at,amount_usd&limit=1`, { single: true }).catch(() => null),
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,status,price_usd,stripe_customer_id,canceled_at&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=size_band,paused_until`, { single: true }).catch(() => null),
        db.select('pricing_config', 'select=matrix&order=effective_from.desc&limit=1', { single: true }).catch(() => null),
        db.select('reports', `tenant_id=eq.${q(tenantId)}&select=summary,findings_snapshot&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.proposed&select=money_impact_usd,finding:findings(money_impact_monthly_usd)`).catch(() => []),
        db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.ads_account&select=currency&limit=1`, { single: true }).catch(() => null),
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=id&limit=1`, { single: true }).catch(() => null),
      ]);
      // Fix access (fix plan move 5): Ads writes ride on the read grant;
      // analytics and tracking writes need the write step. ready | ask | reconnect.
      const conn = owner ? await db.select('google_connections', `user_id=eq.${q(owner.id)}&select=status,scope_level&limit=1`, { single: true }).catch(() => null) : null;
      const fix_access = !conn || conn.status !== 'valid' ? 'reconnect' : (conn.scope_level === 'write' || conn.scope_level === 'create' ? 'ready' : 'ask');
      const base = { ...accessFrom({ paid, sub, tenant, pricing, report, pending, ads }), fix_access };
      // The client's app knows (agency plan move 11): a managed tenant is
      // active on the agency's tier, never asked to pay, and says who looks after it.
      const managed = await managedBy(db, tenantId);
      if (!managed) return base;
      return {
        ...base,
        level: 'active',
        has_customer: true,
        credit_applies: false,
        plan: base.plan || { tier: 'agency', status: 'active', label: `Looked after by ${managed.agency_name}`, price_usd: 0 },
        managed: { agency: managed.agency_name, mode: managed.client_mode },
      };
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
      const nowIso = new Date().toISOString();
      const [rows, camps] = await Promise.all([
        db.select('changes',
          `tenant_id=eq.${q(tenantId)}&status=eq.proposed&or=(snoozed_until.is.null,snoozed_until.lt.${q(nowIso)})&select=id,finding_id,tool_id,params,target,before,after,summary_text,money_impact_usd,ask_reason,category,snoozed_until,finding:findings(title,explanation,money_impact_monthly_usd)&order=created_at.desc`),
        db.select('campaigns', `tenant_id=eq.${q(tenantId)}&select=google_campaign_id,name`).catch(() => []),
      ]);
      const campName = new Map((camps || []).map((c) => [String(c.google_campaign_id), c.name]));
      // "Leave this alone" (fix plan move 7): the fence a card can offer, by campaign.
      const fenceFor = (r) => {
        const m = /^campaign:([^:]+)/.exec(String(r.target || '')) || (r.params && r.params.campaign_id ? [null, String(r.params.campaign_id)] : null);
        if (!m) return null;
        const name = campName.get(String(m[1])) || null;
        return { target: `campaign:${m[1]}`, label: name || 'this campaign', summary_text: `Leave "${name || `campaign ${m[1]}`}" alone` };
      };
      return rows.map((r) => ({
        id: r.id,
        finding_id: r.finding_id || null,
        title: r.summary_text ? asProposal(r.summary_text) : ((r.finding && r.finding.title) || 'A fix is ready'),
        money_line: (r.money_impact_usd || (r.finding && r.finding.money_impact_monthly_usd))
          ? `about ${sym}${Math.round(r.money_impact_usd || r.finding.money_impact_monthly_usd)} a month` : null,
        category: r.category || null,
        ask_reason: r.ask_reason || null,
        // Analytics and tracking changes need the write grant; Ads and settings do not.
        needs_fix_access: !!(r.tool_id && !/^(ads|settings)\./.test(r.tool_id)),
        // A list-shaped proposal (fix plan move 6): each item can be unticked.
        list: r.tool_id === 'ads.add_negative_keywords' && r.params && Array.isArray(r.params.terms) ? r.params.terms.map((t) => t.text).filter(Boolean) : null,
        fence: fenceFor(r),
        // The trust layer: what exactly changes, in plain words, on the card
        // itself. Falls back to the raw before/after when no prose exists.
        explanation: (r.finding && r.finding.explanation) || null,
        before_line: r.before ? (r.before.line || JSON.stringify(r.before).slice(0, 140)) : null,
        after_line: r.after ? (r.after.line || JSON.stringify(r.after).slice(0, 140)) : null,
      }));
    },
    // ---- §7 assistant. The composer is the bot's entry point (§7.4.8): when
    // the assistant is wired, a composer request becomes a chat turn.
    // On for every tenant with an active plan (richer-platform spec §4);
    // tenants.assistant_enabled overrides either way when set.
    assistantEnabled: async (tenantId) => {
      if (!deps.assistant) return false;
      const [t, sub] = await Promise.all([
        db.select('tenants', `id=eq.${q(tenantId)}&select=assistant_enabled`, { single: true }).catch(() => null),
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=status&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
      ]);
      if (t && t.assistant_enabled === false) return false;
      if (t && t.assistant_enabled === true) return true;
      return planIsActive(sub);
    },
    // "Expected, until Sunday" (fix plan move 17): the alert is seen and the
    // period goes on the anomaly calendar, so the pulse stays quiet about it.
    expectAlert: async (tenantId, alertId, untilIso, now = new Date()) => {
      const until = Date.parse(untilIso);
      if (!until || until < now.getTime() || until > now.getTime() + 60 * 86_400_000) return { ok: false, error: 'Pick a date within the next 60 days.' };
      const alert = await db.select('alerts', `id=eq.${q(alertId)}&tenant_id=eq.${q(tenantId)}&select=title,kind`, { single: true }).catch(() => null);
      if (!alert) return { ok: false, error: 'Not found.' };
      await db.update('alerts', `id=eq.${q(alertId)}&tenant_id=eq.${q(tenantId)}`, { acked_at: now.toISOString() });
      await db.insert('anomaly_calendar', [{ tenant_id: tenantId, starts_on: now.toISOString().slice(0, 10), ends_on: new Date(until).toISOString().slice(0, 10), label: `Expected: ${alert.title}`.slice(0, 200), created_from: 'ui' }], { returning: false });
      return { ok: true, until: new Date(until).toISOString().slice(0, 10) };
    },
    // Alerts on Home (spec §2.7): acknowledging is a tap.
    ackAlert: async (tenantId, alertId) => {
      await db.update('alerts', `id=eq.${q(alertId)}&tenant_id=eq.${q(tenantId)}`, { acked_at: new Date().toISOString() });
      return { ok: true };
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
      // unanswered-log row - the customer-written backlog (§11.4).
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
    // Reports held for an agency's review never reach the client (agency plan move 9).
    reports: async (tenantId) => db.select('reports', `tenant_id=eq.${q(tenantId)}&or=(review_status.is.null,review_status.neq.pending)&select=id,type,created_at,viewed_at,summary&order=created_at.desc&limit=50`),
    heldReport: async (tenantId) => db.select('reports', `tenant_id=eq.${q(tenantId)}&review_status=eq.pending&select=id,created_at&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
    managed: (tenantId) => managedBy(db, tenantId),
    // Receipts (richer-platform spec §3, §5): for every applied change in the
    // last 90 days, what happened after. The per-change watch (change_verify)
    // carries the verdict and the measured line; the 48-hour changeset watch
    // covers changes without one. Keyed by change id and by finding id.
    receipts: async (tenantId, now = new Date()) => {
      const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
      const [appliedRows, failedRows] = await Promise.all([
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=in.(applied,reverted)&applied_at=gte.${q(since)}&select=id,finding_id,applied_at,changeset_id,status&order=applied_at.desc&limit=200`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(tenantId)}&status=eq.failed&created_at=gte.${q(since)}&select=id,finding_id,created_at,changeset_id,status&order=created_at.desc&limit=50`).catch(() => []),
      ]);
      const changes = [...(appliedRows || []), ...(failedRows || []).map((c) => ({ ...c, applied_at: null }))];
      if (!changes.length) return { by_change: {}, by_finding: {} };
      const changeIds = changes.map((c) => c.id);
      const setIds = [...new Set(changes.map((c) => c.changeset_id).filter(Boolean))];
      const targets = [...changeIds, ...setIds].map(q).join(',');
      const [watches, lines] = await Promise.all([
        db.select('watches', `tenant_id=eq.${q(tenantId)}&kind=in.(change_verify,changeset_verify)&target_id=in.(${targets})&select=target_id,kind,status,outcome,closed_at,schedule`).catch(() => []),
        db.select('ledger', `tenant_id=eq.${q(tenantId)}&event=in.(watch_verified,watch_inconclusive,watch_regressed,auto_reverted,fix_reverted,fix_failed)&change_id=in.(${changeIds.map(q).join(',')})&select=change_id,event,summary_text,created_at`).catch(() => []),
      ]);
      const byTarget = new Map((watches || []).map((w) => [`${w.kind}:${w.target_id}`, w]));
      const lineFor = new Map();
      for (const l of lines || []) if (!lineFor.has(l.change_id)) lineFor.set(l.change_id, l);
      const by_change = {}; const by_finding = {};
      for (const c of changes) {
        const own = byTarget.get(`change_verify:${c.id}`) || null;
        const set = c.changeset_id ? byTarget.get(`changeset_verify:${c.changeset_id}`) || null : null;
        const l = lineFor.get(c.id) || null;
        const line = l ? l.summary_text.replace(/^.*?: /, '') : null;
        let state = 'watching'; let verified_at = null;
        if (c.status === 'failed') state = 'failed';
        else if (c.status === 'reverted' || (l && (l.event === 'auto_reverted' || l.event === 'fix_reverted'))) state = 'reverted';
        else if (own && own.outcome === 'verified') { state = 'verified'; verified_at = own.closed_at; }
        else if (own && own.outcome === 'inconclusive') { state = 'inconclusive'; verified_at = own.closed_at; }
        else if (own && own.outcome === 'regressed') state = 'reverted';
        else if (!own && set && set.status === 'resolved') { state = 'verified'; verified_at = set.closed_at || (set.schedule && set.schedule.until) || null; }
        else if (!own && set && set.status === 'triggered') state = 'reverted';
        const until = (own && own.schedule && own.schedule.until) || (set && set.schedule && set.schedule.until) || null;
        const r = { change_id: c.id, finding_id: c.finding_id || null, applied_at: c.applied_at, state, verified_at, line, watch_until: state === 'watching' ? until : null };
        by_change[c.id] = r;
        if (c.finding_id && !by_finding[c.finding_id]) by_finding[c.finding_id] = r;
      }
      return { by_change, by_finding };
    },
    reportData: async (tenantId, reportId) => {
      const r = await db.select('reports',
        `id=eq.${q(reportId)}&tenant_id=eq.${q(tenantId)}&select=id,type,created_at,findings_snapshot,unlocked,summary,review_status`, { single: true });
      if (r && r.review_status === 'pending') return { held: true };
      if (r) await db.update('reports', `id=eq.${q(reportId)}`, { viewed_at: new Date().toISOString() }).catch(() => {});
      return r;
    },
    ledger: async (tenantId) => db.select('ledger', `tenant_id=eq.${q(tenantId)}&select=*&order=created_at.desc&limit=100`),
    settings: async (tenantId, now = new Date()) => {
      // users → google_connections (one owner per tenant in v1). PostgREST has
      // no SQL subqueries; the old `user_id=in.(select …)` filter 400'd and every
      // tenant read "Google connection pending." whatever the real status.
      const [sub, auto, owner, tenant, lastRuns, ads] = await Promise.all([
        db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&select=tier,size_band,price_usd,status&limit=1`, { single: true }),
        db.select('autopilot_settings', `tenant_id=eq.${q(tenantId)}&select=categories`, { single: true }),
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=id,email&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=business_name,website_url,size_band,timezone,email_reports,assistant_enabled`, { single: true }).catch(() => null),
        store.runs(tenantId).catch(() => []),
        db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.ads_account&select=currency&limit=1`, { single: true }).catch(() => null),
      ]);
      const conn = owner
        ? await db.select('google_connections', `user_id=eq.${q(owner.id)}&select=status&limit=1`, { single: true }).catch(() => null)
        : null;
      const CONNECTION_LINE = {
        valid: 'Google connection healthy.',
        expired: 'Google connection expired - sign in again to reconnect.',
        revoked: 'Google access was removed - sign in again to reconnect.',
      };
      // Weekly checks run in the Sunday window (Gulf time, journeys/scheduling).
      const nowMs = now.getTime();
      const localDow = new Date(nowMs + 4 * 3600_000).getUTCDay();
      const nextDays = localDow === 0 ? 7 : 7 - localDow;
      // The date in Gulf time, not UTC, so a Saturday night never reads as Saturday.
      const nextRun = new Date(nowMs + 4 * 3600_000); nextRun.setUTCDate(nextRun.getUTCDate() + nextDays);
      return {
        plan_line: sub ? `${sub.tier[0].toUpperCase()}${sub.tier.slice(1)} · $${sub.price_usd}/mo (${sub.status})` : 'Free check - no plan yet',
        autopilot: (auto && auto.categories) || {},
        connection_status: (conn && CONNECTION_LINE[conn.status]) || 'Google connection pending.',
        assistant_enabled: await store.assistantEnabled(tenantId),
        weekly: {
          timezone: (tenant && tenant.timezone) || null,
          next_run_at: nextRun.toISOString().slice(0, 10),
          next_check_days: nextDays,
          last_runs: lastRuns || [],
        },
        emails: { reports: !(tenant && tenant.email_reports === false), address: (owner && owner.email) || null },
        business: {
          name: (tenant && tenant.business_name) || null,
          website: (tenant && tenant.website_url) || null,
          currency: (ads && ads.currency) || 'USD',
          band: (tenant && tenant.size_band) || (sub && sub.size_band) || '4k',
        },
      };
    },
    // The last three checks (richer-platform spec §6, Settings).
    runs: async (tenantId) => {
      const rows = await db.select('runs', `tenant_id=eq.${q(tenantId)}&select=id,type,status,started_at,finished_at&order=started_at.desc.nullslast&limit=3`).catch(() => []);
      return (rows || []).map((r) => ({ id: r.id, type: r.type, status: r.status, started_at: r.started_at, finished_at: r.finished_at }));
    },
    emailPayLink: async (tenantId, { to, url, tier }) => {
      const [owner, tenant, pricing] = await Promise.all([
        db.select('users', `tenant_id=eq.${q(tenantId)}&role=eq.owner&select=email,name&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=business_name,website_url,size_band`, { single: true }).catch(() => null),
        db.select('pricing_config', 'select=matrix&order=effective_from.desc&limit=1', { single: true }).catch(() => null),
      ]);
      const band = (tenant && tenant.size_band) || '4k';
      const matrix = (pricing && pricing.matrix) || {};
      const price = matrix[tier] && matrix[tier][band] ? `$${matrix[tier][band]}` : null;
      await db.insert('emails', [{ tenant_id: tenantId, template_id: 'pay_link', to_email: to, stream: 'transactional', status: 'queued', payload: { from_name: (owner && (owner.name || owner.email)) || 'The owner', business: (tenant && (tenant.business_name || tenant.website_url)) || 'the business', tier: tier ? tier[0].toUpperCase() + tier.slice(1) : 'Core', price, pay_url: url } }], { returning: false });
      return { ok: true };
    },
    websiteOf: async (tenantId) => { const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true }).catch(() => null); return (t && t.website_url) ? String(t.website_url).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase() : null; },
    // Business card (spec §6): name and website feed the report header; the
    // timezone is what the browser reported at first sign-in.
    setBusiness: async (tenantId, { name, website, timezone } = {}) => {
      const patch = {};
      if (name !== undefined) patch.business_name = String(name || '').trim().slice(0, 120) || null;
      if (website !== undefined) patch.website_url = String(website || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').slice(0, 200) || null;
      if (timezone !== undefined && /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(String(timezone || ''))) patch.timezone = String(timezone).slice(0, 64);
      if (!Object.keys(patch).length) return { ok: false };
      await db.update('tenants', `id=eq.${q(tenantId)}`, patch);
      return { ok: true, ...patch };
    },
    // Weekly report emails on or off. The List-Unsubscribe link writes the
    // same flag; alerts about breakage are never gated by it.
    setEmailReports: async (tenantId, on) => {
      await db.update('tenants', `id=eq.${q(tenantId)}`, { email_reports: !!on });
      return { ok: true, reports: !!on };
    },
    // What this Google login can see, with an honest state per door (fix plan
    // move 1): matched, choose (candidates with spend), unused (the site does
    // not carry it), cannot_see (the site carries it, this login cannot see it).
    discovery: async (tenantId) => {
      const [assets, tenant] = await Promise.all([
        db.select('assets', `tenant_id=eq.${q(tenantId)}&select=id,kind,external_id,display_name,currency,linked,metadata`),
        db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true }).catch(() => null),
      ]);
      let tags = null; let domain = null;
      if (tenant && tenant.website_url) {
        try { domain = new URL(tenant.website_url.startsWith('http') ? tenant.website_url : `https://${tenant.website_url}`).hostname; } catch { domain = null; }
        if (domain) {
          const c = await db.select('crawls', `url=ilike.*${q(domain)}*&select=tags_found&order=created_at.desc&limit=1`, { single: true }).catch(() => null);
          tags = (c && c.tags_found) || null;
        }
      }
      const isMatched = (x) => x.linked || !!(x.metadata && x.metadata.matched_via);
      const plain = (x) => ({ id: x.id, kind: x.kind, external_id: x.external_id, display_name: x.display_name, currency: x.currency, linked: x.linked, matched_via: (x.metadata && x.metadata.matched_via) || null, spend_30d_usd: x.metadata && x.metadata.spend_30d_usd != null ? Number(x.metadata.spend_30d_usd) : null, test_account: !!(x.metadata && x.metadata.test_account), suspended: !!(x.metadata && /suspended|canceled|cancelled|closed/i.test(String(x.metadata.account_status || ''))), via_manager: x.metadata && typeof x.metadata.under_mcc === 'string' ? (x.metadata.manager_name || 'a manager account') : null });
      const onSite = { gtm_container: !!(tags && (tags.gtm_containers || []).length), ga4_property: !!(tags && (tags.ga4_ids || []).length), ads_account: !!(tags && (tags.aw_conversion_ids || []).length) };
      const doors = {};
      for (const kind of ['ads_account', 'ga4_property', 'gtm_container']) {
        const ofKind = assets.filter((x) => x.kind === kind);
        const matched = ofKind.filter(isMatched).map(plain);
        const candidates = ofKind.filter((x) => !isMatched(x)).map(plain).sort((x, y) => (y.spend_30d_usd || 0) - (x.spend_30d_usd || 0));
        let state;
        if (matched.length) state = 'matched';
        else if (candidates.length) state = 'choose';
        else if (kind === 'ads_account' || onSite[kind]) state = 'cannot_see';
        else state = 'unused';
        doors[kind] = { state, matched, candidates, suggested: state === 'choose' ? candidates[0].id : null };
      }
      // The "leave alone" list: campaigns of the matched (or suggested) ads account.
      const adsRow = assets.find((x) => x.kind === 'ads_account' && isMatched(x)) || assets.find((x) => x.kind === 'ads_account' && doors.ads_account.suggested === x.id) || null;
      const campaigns = ((adsRow && adsRow.metadata && adsRow.metadata.campaigns) || []).map((c) => ({ id: String(c.id), name: c.name, status: c.status || null, spend_30d_usd: c.spend_30d_usd != null ? Number(c.spend_30d_usd) : null }));
      // The ga4_stream rows ride under the analytics door for the old screen shape.
      const matched = assets.filter(isMatched).map(plain);
      const unmatched = assets.filter((x) => !isMatched(x)).map(plain);
      // The business already has an account (fix plan move 12): say so, offer to ask the owner.
      let duplicate_of = null;
      if (domain) {
        const host = domain.replace(/^www\./, '');
        const others = await db.select('tenants', `id=neq.${q(tenantId)}&status=in.(active,paused)&or=(website_url.ilike.${q(host)},website_url.ilike.www.${q(host)},website_url.ilike.https://${q(host)}*,website_url.ilike.http://${q(host)}*)&select=id,business_name,website_url&order=created_at.asc&limit=1`).catch(() => []);
        const o = (others || [])[0];
        if (o) {
          const runs = await db.select('runs', `tenant_id=eq.${q(o.id)}&status=in.(complete,degraded)&select=id&limit=1`).catch(() => []);
          if (runs && runs.length) duplicate_of = { tenant_id: o.id, business: o.business_name || o.website_url || 'This business' };
        }
      }
      return { matched, unmatched, doors, campaigns, site: domain, no_access: assets.length === 0, duplicate_of };
    },
    // Ask the owner to add me (fix plan move 12): one email with an approve link.
    joinRequest: async (tenantId, { baseUrl = 'https://app.tryinsyt.com', now = Date.now() } = {}) => {
      const d = await store.discovery(tenantId);
      if (!d.duplicate_of) return { ok: false, error: 'No other account for this website.' };
      const [me, owner] = await Promise.all([
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=id,email&limit=1`, { single: true }).catch(() => null),
        db.select('users', `tenant_id=eq.${q(d.duplicate_of.tenant_id)}&role=eq.owner&select=email&limit=1`, { single: true }).catch(() => null),
      ]);
      if (!me || !owner || !owner.email) return { ok: false, error: 'We could not reach the owner.' };
      const { mintLink } = require('../../emails/src/magic-links');
      const inserts = [];
      const link = mintLink({ tenantId: d.duplicate_of.tenant_id, purpose: 'join_approve', targetId: me.id, baseUrl, now }, { insertLink: (row) => inserts.push(db.insert('magic_links', [row], { returning: false })) });
      await Promise.all(inserts);
      await db.insert('emails', [{ tenant_id: d.duplicate_of.tenant_id, template_id: 'join_request', to_email: owner.email, stream: 'transactional', status: 'queued', payload: { from_email: me.email, business: d.duplicate_of.business, site: d.site, approve_url: link.url } }], { returning: false });
      return { ok: true, business: d.duplicate_of.business };
    },
    // The owner tapped Add them: the requester becomes a viewer on the owner's account.
    approveJoin: async (ownerTenantId, userId) => {
      const u = await db.select('users', `id=eq.${q(userId)}&select=id,tenant_id,email`, { single: true }).catch(() => null);
      if (!u || u.tenant_id === ownerTenantId) return { ok: false };
      await db.update('users', `id=eq.${q(userId)}`, { tenant_id: ownerTenantId, role: 'viewer' });
      await db.update('tenants', `id=eq.${q(u.tenant_id)}`, { status: 'cancelled' }).catch(() => {});
      await db.insert('ledger', [{ tenant_id: ownerTenantId, event: 'connection_changed', actor: 'user', summary_text: `${u.email} can now see this account (view only).` }], { returning: false }).catch(() => {});
      return { ok: true, email: u.email };
    },
    // Invite someone to see this (fix plan move 12): a viewer link, read-only, 30 days.
    inviteViewer: async (tenantId, email, { baseUrl = 'https://app.tryinsyt.com', now = Date.now() } = {}) => {
      const to = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: 'That does not look like an email address.' };
      const [owner, tenant] = await Promise.all([
        db.select('users', `tenant_id=eq.${q(tenantId)}&role=eq.owner&select=email,name&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=business_name,website_url`, { single: true }).catch(() => null),
      ]);
      const { mintLink } = require('../../emails/src/magic-links');
      const inserts = [];
      const link = mintLink({ tenantId, purpose: 'join_viewer', targetId: null, baseUrl, now }, { insertLink: (row) => inserts.push(db.insert('magic_links', [row], { returning: false })) });
      await Promise.all(inserts);
      await db.insert('emails', [{ tenant_id: tenantId, template_id: 'viewer_invite', to_email: to, stream: 'transactional', status: 'queued', payload: { from_name: (owner && (owner.name || owner.email)) || 'The owner', business: (tenant && (tenant.business_name || tenant.website_url)) || 'the business', join_url: link.url } }], { returning: false });
      await db.insert('ledger', [{ tenant_id: tenantId, event: 'connection_changed', actor: 'user', summary_text: `Invited ${to} to see this account (view only).` }], { returning: false }).catch(() => {});
      return { ok: true };
    },
    // The businesses this login owns, and adding another one.
    businesses: async (tenantId) => {
      const me = await db.select('users', `tenant_id=eq.${q(tenantId)}&select=google_sub&limit=1`, { single: true }).catch(() => null);
      if (!me || !me.google_sub) return [];
      const rows = await db.select('users', `google_sub=eq.${q(me.google_sub)}&role=eq.owner&select=tenant_id,tenant:tenants(business_name,website_url,status)&order=last_seen_at.desc.nullslast`).catch(() => []);
      return (rows || []).filter((r) => r.tenant && r.tenant.status !== 'cancelled').map((r) => ({ tenant_id: r.tenant_id, name: r.tenant.business_name || r.tenant.website_url || 'Business', website: r.tenant.website_url || null, current: r.tenant_id === tenantId }));
    },
    addBusiness: async (tenantId, website) => {
      const site = String(website || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase().slice(0, 200);
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) return { ok: false, error: 'That does not look like a website address.' };
      const me = await db.select('users', `tenant_id=eq.${q(tenantId)}&role=eq.owner&select=id,google_sub,email,name`, { single: true }).catch(() => null);
      if (!me) return { ok: false, error: 'Only the owner can add a business.' };
      const conn = await db.select('google_connections', `user_id=eq.${q(me.id)}&select=refresh_token,granted_scopes,scope_level,status`, { single: true }).catch(() => null);
      const [tenant] = await db.insert('tenants', [{ status: 'active', website_url: site }]);
      const [user] = await db.insert('users', [{ tenant_id: tenant.id, google_sub: me.google_sub, email: me.email, name: me.name || null, role: 'owner', last_seen_at: new Date().toISOString() }]);
      if (conn && conn.refresh_token) await db.insert('google_connections', [{ user_id: user.id, refresh_token: conn.refresh_token, granted_scopes: conn.granted_scopes, scope_level: conn.scope_level, status: conn.status, last_validated_at: new Date().toISOString() }], { returning: false }).catch(() => {});
      await db.insert('ledger', [{ tenant_id: tenant.id, event: 'connection_changed', actor: 'user', summary_text: 'Business added from your other Insyt account. Google connected, read access.' }], { returning: false }).catch(() => {});
      return { ok: true, tenant_id: tenant.id };
    },
    switchTenant: async (tenantId, toTenantId) => {
      const me = await db.select('users', `tenant_id=eq.${q(tenantId)}&select=google_sub&limit=1`, { single: true }).catch(() => null);
      if (!me) return { ok: false };
      const other = await db.select('users', `tenant_id=eq.${q(toTenantId)}&google_sub=eq.${q(me.google_sub)}&role=eq.owner&select=id`, { single: true }).catch(() => null);
      if (!other) return { ok: false };
      await db.update('users', `id=eq.${q(other.id)}`, { last_seen_at: new Date().toISOString() }).catch(() => {});
      return { ok: true };
    },
    // Link only what the confirm page presented as "your setup": assets matched
    // to the site (matched_via set by discovery) or chosen by the owner on the
    // confirm screen. Anything else stays unlinked: one Google login often
    // spans several businesses, and auditing (or proposing changes for) a
    // sibling business's Ads account is never OK. Fences (fix plan move 7)
    // are standing exceptions on a whole target, written before the first
    // proposal exists.
    confirmAssets: async (tenantId, { link = [], exceptions = [] } = {}) => {
      await db.update('assets', `tenant_id=eq.${q(tenantId)}&metadata->>matched_via=not.is.null`, { linked: true });
      const chosen = [...new Set((Array.isArray(link) ? link : []).map(String))].slice(0, 10);
      for (const id of chosen) {
        const row = await db.select('assets', `id=eq.${q(id)}&tenant_id=eq.${q(tenantId)}&select=id,metadata`, { single: true }).catch(() => null);
        if (!row) continue;
        await db.update('assets', `id=eq.${q(id)}&tenant_id=eq.${q(tenantId)}`, { linked: true, metadata: { ...(row.metadata || {}), matched_via: 'owner_choice' } }).catch(() => {});
      }
      const fences = (Array.isArray(exceptions) ? exceptions : []).filter((e) => e && typeof e.target === 'string' && /^[a-z_]+:[A-Za-z0-9_~-]+$/.test(e.target)).slice(0, 50);
      if (fences.length) {
        await db.insert('standing_exceptions', fences.map((e) => ({
          tenant_id: tenantId, change_key: `fence:${e.target}`, target: e.target,
          summary_text: String(e.summary_text || `Leave ${e.target} alone`).slice(0, 200), created_from: 'ui',
        })), { returning: false }).catch(() => {});
      }
      return { linked: chosen.length, fenced: fences.length };
    },
    // "Type the email of whoever does" (fix plan move 1): ask the person who
    // holds the Google login to connect it. One email, no account created.
    accessRequest: async (tenantId, email, baseUrl = 'https://app.tryinsyt.com') => {
      const to = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: 'That does not look like an email address.' };
      const [owner, tenant] = await Promise.all([
        db.select('users', `tenant_id=eq.${q(tenantId)}&select=email,name&limit=1`, { single: true }).catch(() => null),
        db.select('tenants', `id=eq.${q(tenantId)}&select=website_url`, { single: true }).catch(() => null),
      ]);
      await db.insert('emails', [{
        tenant_id: tenantId, template_id: 'access_request', to_email: to, stream: 'transactional', status: 'queued',
        payload: { site: (tenant && tenant.website_url) || 'their website', from_name: (owner && (owner.name || owner.email)) || 'The owner', start_url: `${baseUrl}/app/start${tenant && tenant.website_url ? `?url=${encodeURIComponent(tenant.website_url)}` : ''}` },
      }], { returning: false });
      return { ok: true };
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
      if (!j) return { journey: 'A', stage: 'active', gates: { tag: true, billing: true, approval: true }, instruction_line: 'Everything is set up - your weekly checks run automatically.' };
      const next = !j.gates.tag ? 'Install your tracking - the guide takes 30 seconds.'
        : !j.gates.approval ? 'Review and approve your campaigns.'
          : !j.gates.billing ? 'Connect your ad money to Google - last step.' : 'All gates clear - launching.';
      return { ...j, instruction_line: next };
    },
    approveChange: async (tenantId, changeId, { keep = null } = {}) => {
      const ch = await db.select('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&select=tool_id,params,status`, { single: true }).catch(() => null);
      // Partial yes (fix plan move 6): a list-shaped proposal keeps only the ticked items.
      if (ch && ch.status === 'proposed' && Array.isArray(keep) && ch.tool_id === 'ads.add_negative_keywords' && ch.params && Array.isArray(ch.params.terms)) {
        const keepSet = new Set(keep.map(String));
        const terms = ch.params.terms.filter((t) => keepSet.has(String(t.text)));
        if (!terms.length) return;
        if (terms.length < ch.params.terms.length) {
          await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&status=eq.proposed`, {
            params: { ...ch.params, terms },
            summary_text: `Exclude ${terms.length} search${terms.length === 1 ? '' : 'es'} from your ads`,
          }).catch(() => {});
        }
      }
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
      // Idempotent: only a proposed change moves. The Checkout return path may
      // approve the same change twice (webhook, then the returning tab).
      if (ch && ch.status && ch.status !== 'proposed') return;
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&status=eq.proposed`, { status: 'approved' });
      await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: changeId, channel: 'dashboard' }], { returning: false });
      await tel.event({ tenantId, name: 'approval.approve', props: { change_id: changeId }, source: 'server' });
      await mirrorToAgencyBound(tenantId, 'client_approved', { change_id: changeId });
    },
    // "Approve all safe fixes" / "Do all N fixes" (richer-platform spec §2.4,
    // §3, §4): the same yes, once per id, through approveChange so every
    // guard (idempotent, tenant-scoped, settings cards) holds. The worker
    // applies them as today.
    approveBatch: async (tenantId, ids) => {
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 50);
      let approved = 0;
      for (const id of list) {
        try { await store.approveChange(tenantId, id); approved += 1; } catch { /* one bad id never blocks the rest */ }
      }
      return { approved, requested: list.length };
    },
    // Later (fix plan move 6): the card comes back in `days` days, no reason asked.
    snoozeChange: async (tenantId, changeId, days = 7) => {
      const d = Math.min(Math.max(Number(days) || 7, 1), 30);
      const until = new Date(Date.now() + d * 86_400_000).toISOString();
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&status=eq.proposed`, { snoozed_until: until });
      return { ok: true, until };
    },
    // Leave this alone (fix plan move 7): a fence on a whole target, from a
    // card, from Confirm, or from Settings. Optionally puts the card away.
    addFence: async (tenantId, { target, summary_text, change_id = null } = {}) => {
      if (typeof target !== 'string' || !/^[a-z_]+:[A-Za-z0-9_~-]+$/.test(target)) return { ok: false, error: 'Nothing to fence.' };
      const existing = await db.select('standing_exceptions', `tenant_id=eq.${q(tenantId)}&change_key=eq.${q(`fence:${target}`)}&cleared_at=is.null&select=id`, { single: true }).catch(() => null);
      if (!existing) {
        await db.insert('standing_exceptions', [{ tenant_id: tenantId, change_key: `fence:${target}`, target, summary_text: String(summary_text || `Leave ${target} alone`).slice(0, 200), created_from: 'ui' }], { returning: false });
        await db.insert('ledger', [{ tenant_id: tenantId, event: 'exception_added', actor: 'user', summary_text: `${String(summary_text || `Leave ${target} alone`).slice(0, 160)}. We will not touch it, not even on Autopilot.` }], { returning: false }).catch(() => {});
      }
      if (change_id) await store.dismissChange(tenantId, change_id, { reason: 'leave alone' }).catch(() => {});
      return { ok: true };
    },
    // Pause everything until a date (fix plan move 13): checks, proposals,
    // emails and the bill stop; breakage alerts never do.
    pauseTenant: async (tenantId, untilIso) => {
      const until = Date.parse(untilIso);
      const max = Date.now() + 90 * 86_400_000;
      if (!until || until < Date.now() + 86_400_000 || until > max) return { ok: false, error: 'Pick a date between tomorrow and 90 days from now.' };
      const iso = new Date(until).toISOString();
      await db.update('tenants', `id=eq.${q(tenantId)}`, { status: 'paused', paused_until: iso });
      await db.insert('ledger', [{ tenant_id: tenantId, event: 'subscription_changed', actor: 'user', summary_text: `Paused until ${iso.slice(0, 10)}. Checks, proposals and the bill stop until then; alerts about breakage still reach you.` }], { returning: false }).catch(() => {});
      const sub = await db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&status=in.(active,past_due,trialing)&select=stripe_subscription_id&order=created_at.desc&limit=1`, { single: true }).catch(() => null);
      return { ok: true, paused_until: iso, stripe_subscription_id: sub ? sub.stripe_subscription_id : null };
    },
    resumeTenant: async (tenantId) => {
      await db.update('tenants', `id=eq.${q(tenantId)}&status=eq.paused`, { status: 'active', paused_until: null });
      await db.insert('ledger', [{ tenant_id: tenantId, event: 'subscription_changed', actor: 'user', summary_text: 'Back on. Checks run again from the next Sunday.' }], { returning: false }).catch(() => {});
      const sub = await db.select('subscriptions', `tenant_id=eq.${q(tenantId)}&status=in.(active,past_due,trialing)&select=stripe_subscription_id&order=created_at.desc&limit=1`, { single: true }).catch(() => null);
      return { ok: true, stripe_subscription_id: sub ? sub.stripe_subscription_id : null };
    },
    // What can be fenced from Settings: the campaigns we last saw.
    fenceOptions: async (tenantId) => {
      const [camps, fences] = await Promise.all([
        db.select('campaigns', `tenant_id=eq.${q(tenantId)}&select=google_campaign_id,name,status,budget_daily_usd&order=name.asc&limit=100`).catch(() => []),
        db.select('standing_exceptions', `tenant_id=eq.${q(tenantId)}&cleared_at=is.null&change_key=like.fence:*&select=target`).catch(() => []),
      ]);
      const fenced = new Set((fences || []).map((f) => f.target));
      return (camps || []).map((c) => ({ target: `campaign:${c.google_campaign_id}`, name: c.name, status: c.status || null, budget_daily_usd: c.budget_daily_usd != null ? Number(c.budget_daily_usd) : null, fenced: fenced.has(`campaign:${c.google_campaign_id}`) }));
    },
    // Retry a fix Google refused (fix plan move 9): back to approved, the loop picks it up.
    retryChange: async (tenantId, changeId) => {
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&status=eq.failed`, { status: 'approved', changeset_id: null });
      return { ok: true };
    },
    // Undo with eyes open (fix plan move 9): the then and the now.
    revertPreview: async (tenantId, changeId) => {
      const ch = await db.select('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(tenantId)}&select=tool_id,params,before,after,summary_text,status`, { single: true }).catch(() => null);
      if (!ch) return null;
      let now_line = null;
      if (ch.tool_id === 'ads.adjust_budget' && ch.params && ch.params.campaign_id) {
        const c = await db.select('campaigns', `tenant_id=eq.${q(tenantId)}&google_campaign_id=eq.${q(String(ch.params.campaign_id))}&select=budget_daily_usd,name`, { single: true }).catch(() => null);
        if (c && c.budget_daily_usd != null) now_line = `It runs on $${Number(c.budget_daily_usd)} a day today${Number(c.budget_daily_usd) !== Number(ch.params.new_daily_usd) ? ', which is not what we set' : ''}.`;
      }
      return {
        summary_text: ch.summary_text || null,
        then_line: ch.before && ch.before.line ? `Puts it back to: ${ch.before.line}` : 'Puts it back exactly as it was.',
        now_line,
        can_undo: ch.status === 'applied',
      };
    },
    dismissChange: async (tenantId, changeId, { reason = null, expandedFirst = false } = {}) => {
      await mirrorToAgencyBound(tenantId, 'client_dismissed', { change_id: changeId, reason });
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
      await mirrorToAgencyBound(tenantId, 'client_reverted', { change_id: changeId });
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
    // "What have I told you never to touch?" (§4.5) - listable and clearable.
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
  return store;
}

// ---------------------------------------------------------------- agency (master §13)
// Binding: no auto-apply, no auto-publish. Every mutation logs to
// agency_audit_log with the acting seat - the agency's own dispute record.
function agencyStore(db, deps = {}) {
  const { healthScore } = require('../../rules/src/engine');
  const { pace, sortPacing, targetStatus } = require('../../pacing/src/pacing');
  const { createDraftService } = require('../../campaigns/src/service');
  const drafts = createDraftService({ db, google: deps.google || null, model: deps.model || null, modelId: deps.modelId || null });
  // The trail is the product (agency plan move 12): a failed log insert fails the action.
  const log = async (agencyId, seatId, event, detail) => {
    await db.insert('agency_audit_log', [{ agency_id: agencyId, seat_id: seatId, event, detail: detail || {} }], { returning: false });
  };
  // Every write stays home (agency plan move 1): a change, alert or report is
  // actionable only when its tenant is one of this agency's active accounts.
  // Foreign ids resolve to null and the caller refuses; nothing fails open.
  // Account managers are scoped to their assigned accounts, plus the ones
  // nobody has been assigned yet (agency plan move 7). Admins and read-only
  // seats see the whole portfolio. `scope` is { seatId } or null.
  const scopeFilter = (scope) => (scope && scope.seatId ? `&or=(seat_id.eq.${q(scope.seatId)},seat_id.is.null)` : '');
  const accountsFor = (agencyId, statuses, select, scope) => db.select('agency_accounts',
    `agency_id=eq.${q(agencyId)}&status=${statuses}${scopeFilter(scope)}&select=${select}`);
  const ownedAccount = async (agencyId, tenantId, scope) => {
    if (!tenantId) return null;
    return db.select('agency_accounts',
      `agency_id=eq.${q(agencyId)}&tenant_id=eq.${q(tenantId)}&status=eq.active${scopeFilter(scope)}&select=id,brief_only,display_name`, { single: true }).catch(() => null);
  };
  // The door (fix plan move 14, agency plan move 4): a seven-day link that
  // runs the Google sign-in and binds the seat to the identity that arrives.
  // Earlier links for the same seat expire when a new one goes out.
  const sendInvite = async (agencyId, seatId, seat, { baseUrl = 'https://app.tryinsyt.com', now = Date.now() } = {}) => {
    try {
      const [inviter, agency] = await Promise.all([
        db.select('agency_seats', `id=eq.${q(seatId)}&select=tenant_id,name,email`, { single: true }).catch(() => null),
        db.select('agencies', `id=eq.${q(agencyId)}&select=name`, { single: true }).catch(() => null),
      ]);
      const linkTenant = inviter && inviter.tenant_id;
      if (!linkTenant) return { status: 'failed', at: null };
      const { mintLink } = require('../../emails/src/magic-links');
      await db.update('magic_links', `purpose=eq.join_agency&target_id=eq.${q(seat.id)}&used_at=is.null`, { expires_at: new Date(now).toISOString() }).catch(() => {});
      const inserts = [];
      const link = mintLink({ tenantId: linkTenant, purpose: 'join_agency', targetId: seat.id, baseUrl, now }, { insertLink: (r) => inserts.push(db.insert('magic_links', [r], { returning: false })) });
      await Promise.all(inserts);
      const ROLE = { admin: 'an admin', am: 'an account manager', readonly: 'read-only' };
      const at = new Date(now).toISOString();
      await db.insert('emails', [{ tenant_id: linkTenant, template_id: 'agency_invite', to_email: seat.email, stream: 'transactional', status: 'queued', payload: { agency: (agency && agency.name) || 'the agency', from_name: (inviter && (inviter.name || inviter.email)) || 'An admin', role_label: ROLE[seat.role || 'am'], join_url: link.url } }], { returning: false });
      await db.update('agency_seats', `id=eq.${q(seat.id)}`, { invite_sent_at: at }).catch(() => {});
      return { status: 'queued', at };
    } catch { return { status: 'failed', at: null }; }
  };
  // Connect for the client (fix plan move 14): one email, one tap, their
  // Google login lands on this account and the first audit runs by itself.
  const requestAccess = async (agencyId, seatId, acc, to, { baseUrl = 'https://app.tryinsyt.com', now = Date.now() } = {}) => {
    try {
      const agency = await db.select('agencies', `id=eq.${q(agencyId)}&select=name`, { single: true }).catch(() => null);
      const { mintLink } = require('../../emails/src/magic-links');
      await db.update('magic_links', `purpose=eq.join_account&tenant_id=eq.${q(acc.tenant_id)}&used_at=is.null`, { expires_at: new Date(now).toISOString() }).catch(() => {});
      const inserts = [];
      const link = mintLink({ tenantId: acc.tenant_id, purpose: 'join_account', targetId: acc.id, baseUrl, now }, { insertLink: (r) => inserts.push(db.insert('magic_links', [r], { returning: false })) });
      await Promise.all(inserts);
      const at = new Date(now).toISOString();
      await db.insert('emails', [{ tenant_id: acc.tenant_id, template_id: 'access_request', to_email: to, stream: 'transactional', status: 'queued', payload: { site: acc.site || acc.display_name, from_name: (agency && agency.name) || 'Your agency', start_url: link.url } }], { returning: false });
      await db.update('agency_accounts', `id=eq.${q(acc.id)}`, { request_email: to, request_sent_at: at }).catch(() => {});
      await log(agencyId, seatId, 'access_requested', { account_id: acc.id, email: to });
      return { ok: true, at };
    } catch { return { ok: false }; }
  };
  const ownedRow = async (agencyId, table, id, extra = '', scope = null) => {
    const row = await db.select(table, `id=eq.${q(id)}&select=id,tenant_id${extra}`, { single: true }).catch(() => null);
    if (!row) return null;
    const account = await ownedAccount(agencyId, row.tenant_id, scope);
    return account ? { row, account } : null;
  };
  // What happened after yes (agency plan move 8): the approval row carries
  // the seat, and the client's History says who approved it, at once.
  const mirrorApproval = async (tenantId, changeId, seatId, who) => {
    await db.insert('approvals', [{ tenant_id: tenantId, scope: 'change', target_id: changeId, channel: 'agency' }], { returning: false }).catch(() => {});
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'fix_approved', actor: `seat:${seatId}`, change_id: changeId, summary_text: `Approved by ${who}. Applying within the hour, then watched for 48 hours.` }], { returning: false }).catch(() => {});
  };
  const agencyName = async (agencyId) => {
    const a = await db.select('agencies', `id=eq.${q(agencyId)}&select=name`, { single: true }).catch(() => null);
    return (a && a.name) || 'Your agency';
  };
  // Connection state per client tenant: connected | reconnect | none.
  const connectionsFor = async (tenantIds) => {
    if (!tenantIds.length) return {};
    const owners = await db.select('users', `tenant_id=in.(${tenantIds.map(q).join(',')})&role=eq.owner&select=id,tenant_id`).catch(() => []);
    const conns = (owners || []).length ? await db.select('google_connections', `user_id=in.(${owners.map((o) => q(o.id)).join(',')})&select=user_id,status,scope_level`).catch(() => []) : [];
    const byUser = Object.fromEntries((conns || []).map((c) => [c.user_id, c]));
    const out = {};
    for (const t of tenantIds) out[t] = 'none';
    for (const o of owners || []) {
      const c = byUser[o.id];
      out[o.tenant_id] = !c ? 'none' : c.status === 'valid' ? 'connected' : 'reconnect';
    }
    return out;
  };
  return {
    // Resolve the acting seat from the platform session's tenant id.
    seatByTenant: async (tenantId) => db.select('agency_seats',
      `tenant_id=eq.${q(tenantId)}&status=eq.active&select=id,agency_id,role,name,email&limit=1`, { single: true }),
    // One login may hold seats at more than one agency (agency plan move 4);
    // disabled seats come back too so the route can say so.
    seatsByTenant: async (tenantId) => db.select('agency_seats',
      `tenant_id=eq.${q(tenantId)}&status=in.(active,disabled)&select=id,agency_id,role,name,email,status,agency:agencies(name)&order=created_at.asc`).catch(() => []),
    agency: async (agencyId) => db.select('agencies', `id=eq.${q(agencyId)}&select=*`, { single: true }),

    // Portfolio grid: every managed account with health, pending count and
    // last-report age, computed from one query per table (no N+1).
    portfolio: async (agencyId, scope = null) => {
      const accounts = await accountsFor(agencyId, 'eq.active', 'id,tenant_id,display_name,brief_only,report_register,seat:agency_seats(name)', scope);
      if (!accounts.length) return [];
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const [findings, changes, reports] = await Promise.all([
        db.select('findings', `tenant_id=in.(${ids})&status=in.(open,approved,suspect)&select=tenant_id,severity,status`),
        db.select('changes', `tenant_id=in.(${ids})&status=eq.proposed&select=tenant_id`),
        db.select('reports', `tenant_id=in.(${ids})&select=tenant_id,created_at,review_status&order=created_at.desc&limit=500`),
      ]);
      const by = (rows) => rows.reduce((m, r) => ((m[r.tenant_id] = m[r.tenant_id] || []).push(r), m), {});
      const f = by(findings); const c = by(changes); const r = by(reports);
      const conn = await connectionsFor(accounts.map((a) => a.tenant_id));
      return accounts.map((a) => {
        const own = f[a.tenant_id] || [];
        const latest = (r[a.tenant_id] || [])[0];
        return {
          id: a.id,
          tenant_id: a.tenant_id,
          name: a.display_name,
          connection: conn[a.tenant_id] || 'none',
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
    triage: async (agencyId, scope = null, { snoozed = false, now = new Date().toISOString() } = {}) => {
      const accounts = await accountsFor(agencyId, 'eq.active', 'id,tenant_id,display_name,brief_only', scope);
      if (!accounts.length) return [];
      const nameByTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      // Snoozed items are filtered here, not in the browser (agency plan move 12).
      const snoozeFilter = snoozed ? `&snoozed_until=gt.${q(now)}` : `&or=(snoozed_until.is.null,snoozed_until.lt.${q(now)})`;
      const rows = await db.select('changes',
        `tenant_id=in.(${ids})&status=eq.proposed${snoozeFilter}&select=id,tenant_id,before,after,snoozed_until,snooze_reason,finding:findings(title,explanation,severity,money_impact_monthly_usd,rule_id,layer,campaign_ref,campaign_name,payload)&order=created_at.asc&limit=200`);
      return rows.map((r) => ({
        id: r.id,
        snoozed_until: r.snoozed_until || null,
        snooze_reason: r.snooze_reason || null,
        account: nameByTenant[r.tenant_id] ? nameByTenant[r.tenant_id].display_name : r.tenant_id,
        account_id: nameByTenant[r.tenant_id] ? nameByTenant[r.tenant_id].id : null,
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

    // Campaign snapshots across all managed accounts - powers the scope bar
    // dropdowns and name/ID search. Refreshed by the weekly audit runs.
    campaignsFor: async (agencyId, scope = null) => {
      const accounts = await accountsFor(agencyId, 'in.(pending,active)', 'id,tenant_id,display_name', scope);
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
    draftsFor: async (agencyId, scope = null) => {
      const accounts = await accountsFor(agencyId, 'in.(pending,active)', 'id,tenant_id,display_name', scope);
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
    createDraft: async (agencyId, seatId, { account_id, template, inputs, source_finding }, scope = null) => {
      const acc = await db.select('agency_accounts',
        `id=eq.${q(account_id)}&agency_id=eq.${q(agencyId)}${scopeFilter(scope)}&select=tenant_id,display_name`, { single: true });
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
    // targets - never client fees; that principle is binding).
    pacing: async (agencyId, nowIso, scope = null) => {
      const now = nowIso || new Date().toISOString();
      const monthStart = `${now.slice(0, 8)}01`;
      const sevenAgo = new Date(Date.parse(now) - 7 * 86_400_000).toISOString().slice(0, 10);
      const accounts = await accountsFor(agencyId, 'eq.active', 'id,tenant_id,display_name', scope);
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
    setTargets: async (agencyId, seatId, accountId, patch, scope = null) => {
      const acc = await db.select('agency_accounts',
        `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}${scopeFilter(scope)}&select=tenant_id`, { single: true });
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
    alertsFor: async (agencyId, scope = null) => {
      const accounts = await accountsFor(agencyId, 'in.(pending,active)', 'tenant_id,display_name', scope);
      if (!accounts.length) return [];
      const nameByTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a.display_name]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('alerts',
        `tenant_id=in.(${ids})&select=id,tenant_id,severity,kind,title,detail,campaign_ref,created_at,acked_at,acked_seat:agency_seats(name)&order=created_at.desc&limit=100`);
      return rows.map((r) => ({ ...r, account: nameByTenant[r.tenant_id] }));
    },
    ackAlert: async (agencyId, seatId, alertId, scope = null) => {
      const own = await ownedRow(agencyId, 'alerts', alertId, '', scope);
      if (!own) return { ok: false, reason: 'not_found' };
      await db.update('alerts', `id=eq.${q(alertId)}&tenant_id=eq.${q(own.row.tenant_id)}`, { acked_by: seatId, acked_at: new Date().toISOString() });
      await log(agencyId, seatId, 'alert_acked', { alert_id: alertId, account_id: own.account.id });
      return { ok: true };
    },

    // ---- P0: triage snooze + batch approval. Batch logs every id
    // individually - the audit trail never compresses.
    snoozeChange: async (agencyId, seatId, changeId, days, reason, scope = null) => {
      const own = await ownedRow(agencyId, 'changes', changeId, '', scope);
      if (!own) return { ok: false, reason: 'not_found' };
      const until = new Date(Date.now() + (days || 7) * 86_400_000).toISOString();
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(own.row.tenant_id)}`, { snoozed_until: until, snoozed_by: seatId, snooze_reason: reason || null });
      await log(agencyId, seatId, 'change_snoozed', { change_id: changeId, days: days || 7, reason: reason || null, account_id: own.account.id });
      return { ok: true, until };
    },
    // Batch approve runs the same two checks per id as a single approve
    // (owned, not brief-only) and reports what it skipped and why.
    approveBatch: async (agencyId, seatId, changeIds, scope = null) => {
      let n = 0;
      const skipped = [];
      const who = await agencyName(agencyId);
      for (const id of changeIds || []) {
        const own = await ownedRow(agencyId, 'changes', id, '', scope);
        if (!own) { skipped.push({ id, reason: 'not_found' }); continue; }
        if (own.account.brief_only) { skipped.push({ id, reason: 'brief_only' }); continue; }
        await db.update('changes', `id=eq.${q(id)}&tenant_id=eq.${q(own.row.tenant_id)}`, { status: 'approved' });
        await mirrorApproval(own.row.tenant_id, id, seatId, who);
        await log(agencyId, seatId, 'change_approved', { change_id: id, batch: true, account_id: own.account.id });
        n += 1;
      }
      if (skipped.length) await log(agencyId, seatId, 'write_refused', { action: 'approve_batch', skipped });
      return { approved: n, skipped };
    },

    approveChange: async (agencyId, seatId, changeId, scope = null) => {
      const own = await ownedRow(agencyId, 'changes', changeId, '', scope);
      if (!own) { await log(agencyId, seatId, 'write_refused', { action: 'approve', change_id: changeId, reason: 'not_found' }); return { ok: false, reason: 'not_found' }; }
      if (own.account.brief_only) { await log(agencyId, seatId, 'write_refused', { action: 'approve', change_id: changeId, reason: 'brief_only' }); return { ok: false, reason: 'brief_only' }; }
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(own.row.tenant_id)}`, { status: 'approved' });
      await mirrorApproval(own.row.tenant_id, changeId, seatId, await agencyName(agencyId));
      await log(agencyId, seatId, 'change_approved', { change_id: changeId, account_id: own.account.id });
      return { ok: true };
    },
    dismissChange: async (agencyId, seatId, changeId, reason, scope = null) => {
      const own = await ownedRow(agencyId, 'changes', changeId, ',finding_id,finding:findings(rule_id)', scope);
      if (!own) return { ok: false, reason: 'not_found' };
      const full = own.row;
      // A dismissal, not a failed fix (agency plan move 11): the client's History never offers Retry on it.
      await db.update('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(full.tenant_id)}`, { status: 'dismissed' });
      if (full.finding_id) await db.update('findings', `id=eq.${q(full.finding_id)}&tenant_id=eq.${q(full.tenant_id)}`, { status: 'dismissed' });
      await db.insert('ledger', [{ tenant_id: full.tenant_id, event: 'fix_dismissed', actor: `seat:${seatId}`, change_id: changeId, summary_text: `${await agencyName(agencyId)} decided against this one${reason ? `: ${reason}` : ''}.` }], { returning: false }).catch(() => {});
      await log(agencyId, seatId, 'change_dismissed', { change_id: changeId, reason: reason || null, account_id: own.account.id });
      await require('../../shared/src/telemetry').createTelemetry({ db }).dismissal({
        tenantId: full.tenant_id, changeId, findingId: full.finding_id, ruleId: full.finding ? full.finding.rule_id : null,
        reasonTap: reason, actor: `seat:${seatId}`,
      });
      return { ok: true };
    },

    // Review queue: nothing reaches a client without a seat's approval.
    reviewQueue: async (agencyId, scope = null) => {
      const accounts = await accountsFor(agencyId, 'eq.active', 'tenant_id,display_name', scope);
      if (!accounts.length) return [];
      const nameByTenant = Object.fromEntries(accounts.map((a) => [a.tenant_id, a.display_name]));
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const rows = await db.select('reports',
        `tenant_id=in.(${ids})&review_status=eq.pending&select=id,tenant_id,type,created_at&order=created_at.asc`);
      return rows.map((r) => ({ id: r.id, account: nameByTenant[r.tenant_id], type: r.type, created_at: r.created_at, url: `/r/${r.id}` }));
    },
    approveReport: async (agencyId, seatId, reportId, scope = null) => {
      const own = await ownedRow(agencyId, 'reports', reportId, '', scope);
      if (!own) return { ok: false, reason: 'not_found' };
      await db.update('reports', `id=eq.${q(reportId)}&tenant_id=eq.${q(own.row.tenant_id)}`, { review_status: 'approved', reviewed_by: seatId, reviewed_at: new Date().toISOString() });
      await log(agencyId, seatId, 'report_approved', { report_id: reportId, account_id: own.account.id });
      return { ok: true };
    },
    rejectReport: async (agencyId, seatId, reportId, reason, scope = null) => {
      const own = await ownedRow(agencyId, 'reports', reportId, '', scope);
      if (!own) return { ok: false, reason: 'not_found' };
      await db.update('reports', `id=eq.${q(reportId)}&tenant_id=eq.${q(own.row.tenant_id)}`, { review_status: 'rejected', reviewed_by: seatId, reviewed_at: new Date().toISOString() });
      await log(agencyId, seatId, 'report_rejected', { report_id: reportId, reason: reason || null, account_id: own.account.id });
      return { ok: true };
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

    seats: async (agencyId) => {
      const rows = await db.select('agency_seats',
        `agency_id=eq.${q(agencyId)}&status=neq.removed&select=id,email,name,role,status,created_at,invite_sent_at&order=created_at.asc`);
      // The invite email's fate (agency plan move 4): sent, queued or failed, from the emails row.
      const invited = (rows || []).filter((r) => r.status === 'invited').map((r) => r.email);
      let mail = [];
      if (invited.length) {
        mail = await db.select('emails', `template_id=eq.agency_invite&to_email=in.(${invited.map(q).join(',')})&select=to_email,status,created_at&order=created_at.desc&limit=200`).catch(() => []);
      }
      const latest = {};
      for (const m of mail || []) if (!latest[m.to_email]) latest[m.to_email] = m;
      return (rows || []).map((r) => ({ ...r, invite: r.status === 'invited' ? (latest[r.email] ? { status: latest[r.email].status, at: latest[r.email].created_at } : { status: 'missing', at: r.invite_sent_at }) : null }));
    },
    addSeat: async (agencyId, seatId, { email, name, role }, opts = {}) => {
      const to = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: 'That does not look like an email address.' };
      // One seat per email per agency (agency plan move 4): an invited seat is resent, a live one is refused.
      const existing = await db.select('agency_seats', `agency_id=eq.${q(agencyId)}&email=eq.${q(to)}&status=neq.removed&select=id,status,role,email,name`, { single: true }).catch(() => null);
      if (existing && existing.status === 'invited') {
        const r = await sendInvite(agencyId, seatId, existing, opts);
        await log(agencyId, seatId, 'seat_invite_resent', { email: to, seat_id: existing.id });
        return { ...existing, resent: true, invite: r };
      }
      if (existing) return { error: `${to} already has a seat here.` };
      const [row] = await db.insert('agency_seats', [{ agency_id: agencyId, email: to, name: name || null, role: role || 'am' }]);
      await log(agencyId, seatId, 'seat_invited', { email: to, role: role || 'am' });
      const invite = await sendInvite(agencyId, seatId, { ...row, email: to, name: name || null, role: role || 'am' }, opts);
      return { ...row, email: to, invite };
    },
    resendInvite: async (agencyId, seatId, targetSeatId, opts = {}) => {
      const seat = await db.select('agency_seats', `id=eq.${q(targetSeatId)}&agency_id=eq.${q(agencyId)}&select=id,email,name,role,status`, { single: true }).catch(() => null);
      if (!seat) return { ok: false, reason: 'not_found' };
      if (seat.status !== 'invited') return { ok: false, reason: 'not_invited' };
      const r = await sendInvite(agencyId, seatId, seat, opts);
      await log(agencyId, seatId, 'seat_invite_resent', { email: seat.email, seat_id: seat.id });
      return { ok: true, invite: r };
    },
    // Before any tenant is created for the arriving identity (agency plan
    // move 4): is this seat still open, and is this the person it was for?
    checkSeat: async (seatId, { googleSub, email }) => {
      const seat = await db.select('agency_seats', `id=eq.${q(seatId)}&select=id,agency_id,status,email,google_sub`, { single: true }).catch(() => null);
      if (!seat) return { ok: false, reason: 'unknown' };
      if (seat.status === 'active') return seat.google_sub && seat.google_sub === googleSub ? { ok: true, agency_id: seat.agency_id, already: true } : { ok: false, reason: 'used', invited: seat.email };
      if (seat.status !== 'invited') return { ok: false, reason: 'disabled', invited: seat.email };
      if (String(email || '').trim().toLowerCase() !== String(seat.email || '').toLowerCase()) {
        await log(seat.agency_id, seatId, 'seat_join_refused', { invited_as: seat.email, arrived_as: email || null });
        return { ok: false, reason: 'wrong_account', invited: seat.email };
      }
      return { ok: true, agency_id: seat.agency_id, already: false };
    },
    // The invited person arrived through Google: bind the seat to that identity.
    activateSeat: async (seatId, { tenantId, googleSub, email }) => {
      const seat = await db.select('agency_seats', `id=eq.${q(seatId)}&select=id,agency_id,status,email,google_sub`, { single: true }).catch(() => null);
      if (!seat) return { ok: false, reason: 'unknown' };
      if (seat.status === 'active') return seat.google_sub === googleSub ? { ok: true, agency_id: seat.agency_id, already: true } : { ok: false, reason: 'used' };
      if (seat.status !== 'invited') return { ok: false, reason: 'disabled' };
      if (String(email || '').trim().toLowerCase() !== String(seat.email || '').toLowerCase()) return { ok: false, reason: 'wrong_account', invited: seat.email };
      await db.update('agency_seats', `id=eq.${q(seatId)}`, { tenant_id: tenantId, google_sub: googleSub || null, status: 'active' });
      await log(seat.agency_id, seatId, 'seat_joined', { email: email || seat.email, invited_as: seat.email });
      return { ok: true, agency_id: seat.agency_id, already: false };
    },
    // Brief-only accounts (fix plan move 14). Kept for callers that ask before
    // acting; a change this agency does not own answers true (fails closed).
    briefOnlyFor: async (agencyId, changeId) => {
      const own = await ownedRow(agencyId, 'changes', changeId);
      return !own || !!own.account.brief_only;
    },
    updateSeat: async (agencyId, seatId, targetSeatId, patch) => {
      const allowed = {};
      if (patch.role && ['admin', 'am', 'readonly'].includes(patch.role)) allowed.role = patch.role;
      if (patch.status && ['active', 'disabled', 'removed'].includes(patch.status)) allowed.status = patch.status;
      if (!Object.keys(allowed).length) return { ok: false, reason: 'nothing' };
      if (String(targetSeatId) === String(seatId) && allowed.status) return { ok: false, reason: 'self' };
      const target = await db.select('agency_seats', `id=eq.${q(targetSeatId)}&agency_id=eq.${q(agencyId)}&select=id,status`, { single: true }).catch(() => null);
      if (!target) return { ok: false, reason: 'not_found' };
      // Disabling or removing an invited seat retires it; re-enabling one that never joined makes no sense.
      if (allowed.status === 'active' && target.status === 'invited') delete allowed.status;
      if (!Object.keys(allowed).length) return { ok: false, reason: 'nothing' };
      await db.update('agency_seats', `id=eq.${q(targetSeatId)}&agency_id=eq.${q(agencyId)}`, allowed);
      await log(agencyId, seatId, allowed.status === 'removed' ? 'seat_removed' : allowed.status === 'disabled' ? 'seat_disabled' : 'seat_updated', { seat_id: targetSeatId, ...allowed });
      return { ok: true };
    },

    credits: async (agencyId) => {
      const [bal, events] = await Promise.all([
        db.select('agency_credit_balance', `agency_id=eq.${q(agencyId)}`, { single: true }),
        db.select('audit_credit_events', `agency_id=eq.${q(agencyId)}&select=delta,reason,created_at&order=created_at.desc&limit=50`),
      ]);
      return { balance: bal ? bal.balance : 0, events: events || [] };
    },

    // The work badge in one trip (agency plan move 12).
    counts: async (agencyId, scope = null, now = new Date().toISOString()) => {
      const accounts = await accountsFor(agencyId, 'eq.active', 'tenant_id', scope);
      if (!accounts.length) return { triage: 0, alerts: 0, review: 0 };
      const ids = accounts.map((a) => a.tenant_id).map(q).join(',');
      const [t, a, r] = await Promise.all([
        db.select('changes', `tenant_id=in.(${ids})&status=eq.proposed&or=(snoozed_until.is.null,snoozed_until.lt.${q(now)})&select=id`).catch(() => []),
        db.select('alerts', `tenant_id=in.(${ids})&acked_at=is.null&select=id`).catch(() => []),
        db.select('reports', `tenant_id=in.(${ids})&review_status=eq.pending&select=id`).catch(() => []),
      ]);
      return { triage: (t || []).length, alerts: (a || []).length, review: (r || []).length };
    },
    // The audit trail, its own screen (agency plan move 12): per-account filter, paging, the detail.
    auditLog: async (agencyId, { accountId = null, before = null, limit = 100 } = {}) => db.select('agency_audit_log',
      `agency_id=eq.${q(agencyId)}${accountId ? `&detail->>account_id=eq.${q(accountId)}` : ''}${before ? `&created_at=lt.${q(before)}` : ''}&select=id,event,detail,created_at,seat:agency_seats(name,email)&order=created_at.desc&limit=${Math.min(Math.max(Number(limit) || 100, 1), 500)}`),
    logEvent: (agencyId, seatId, event, detail) => log(agencyId, seatId, event, detail),
    // Who an invite link belonged to, for the page that says it has expired.
    inviteContext: async (seatId) => {
      const seat = await db.select('agency_seats', `id=eq.${q(seatId)}&select=email,status,agency:agencies(name)`, { single: true }).catch(() => null);
      return seat ? { email: seat.email, status: seat.status, agency: seat.agency ? seat.agency.name : null } : null;
    },

    // ---- account lifecycle + platform billing.
    // Billing principle (binding): we bill the agency for the platform, per
    // billable account (pending or active). Paused/removed accounts never
    // bill. The platform never stores or computes what the agency charges
    // its own clients.
    accountsList: async (agencyId, { includeRemoved = false } = {}, scope = null) => db.select('agency_accounts',
      `agency_id=eq.${q(agencyId)}&status=in.(${includeRemoved ? 'pending,active,paused,removed' : 'pending,active,paused'})${scopeFilter(scope)}&select=id,tenant_id,display_name,status,brief_only,report_register,created_at,request_email,request_sent_at,removed_at,seat:agency_seats(name)&order=created_at.asc`),
    addAccount: async (agencyId, seatId, { display_name, email = null, website = null }, opts = {}) => {
      const site = website ? String(website).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase().slice(0, 200) : null;
      const [tenant] = await db.insert('tenants', [{ status: 'active', business_name: display_name, ...(site ? { website_url: site } : {}) }]);
      const [row] = await db.insert('agency_accounts',
        [{ agency_id: agencyId, tenant_id: tenant.id, display_name, status: 'pending' }]);
      await log(agencyId, seatId, 'account_added', { account_id: row.id, display_name });
      const to = String(email || '').trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        const r = await requestAccess(agencyId, seatId, { ...row, tenant_id: tenant.id, display_name, site }, to, opts);
        return { ...row, request_email: to, request_sent_at: r.at || null };
      }
      return row;
    },
    // Request access later (agency plan move 5): the email can arrive after the account does, and can be sent again.
    requestAccess: async (agencyId, seatId, accountId, email, opts = {}) => {
      const to = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, reason: 'email' };
      const acc = await db.select('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}&select=id,tenant_id,display_name,status`, { single: true }).catch(() => null);
      if (!acc) return { ok: false, reason: 'not_found' };
      if (acc.status !== 'pending') return { ok: false, reason: 'connected' };
      const t = await db.select('tenants', `id=eq.${q(acc.tenant_id)}&select=website_url`, { single: true }).catch(() => null);
      const r = await requestAccess(agencyId, seatId, { ...acc, site: t && t.website_url }, to, opts);
      return r.ok ? { ok: true, at: r.at } : { ok: false, reason: 'send_failed' };
    },
    // Pause means pause (agency plan move 6): the client tenant pauses too, so
    // the cron, the poller and the email drain all stop. Remove keeps the row
    // readable, pauses the tenant and tells the client the agency stepped back.
    setAccountStatus: async (agencyId, seatId, accountId, status) => {
      const acc = await db.select('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}&select=id,tenant_id,display_name,status`, { single: true }).catch(() => null);
      if (!acc) return { ok: false, reason: 'not_found' };
      const agency = await db.select('agencies', `id=eq.${q(agencyId)}&select=name`, { single: true }).catch(() => null);
      const who = (agency && agency.name) || 'Your agency';
      const patch = { status };
      if (status === 'removed') patch.removed_at = new Date().toISOString();
      await db.update('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}`, patch);
      await log(agencyId, seatId, `account_${status}`, { account_id: accountId, display_name: acc.display_name });
      if (status === 'paused' || status === 'removed') {
        await db.update('tenants', `id=eq.${q(acc.tenant_id)}&status=eq.active`, { status: 'paused', paused_until: null }).catch(() => {});
        await db.insert('ledger', [{ tenant_id: acc.tenant_id, event: 'subscription_changed', actor: 'system', summary_text: status === 'paused' ? `${who} paused this account. Checks and emails stop until they resume it.` : `${who} has stepped back from this account. Checks and emails have stopped; sign in any time to pick things up yourself.` }], { returning: false }).catch(() => {});
        if (status === 'removed') {
          const owner = await db.select('users', `tenant_id=eq.${q(acc.tenant_id)}&role=eq.owner&select=email&limit=1`, { single: true }).catch(() => null);
          if (owner && owner.email) await db.insert('emails', [{ tenant_id: acc.tenant_id, template_id: 'agency_stepped_back', to_email: owner.email, stream: 'transactional', status: 'queued', payload: { agency: who, business: acc.display_name } }], { returning: false }).catch(() => {});
        }
      }
      if (status === 'active' && acc.status === 'paused') {
        await db.update('tenants', `id=eq.${q(acc.tenant_id)}&status=eq.paused`, { status: 'active', paused_until: null }).catch(() => {});
        await db.insert('ledger', [{ tenant_id: acc.tenant_id, event: 'subscription_changed', actor: 'system', summary_text: `${who} resumed this account. Checks run again from the next Sunday.` }], { returning: false }).catch(() => {});
      }
      return { ok: true };
    },
    // Clients land where they belong (agency plan move 5): the arriving login
    // already owns a tenant, so the agency's empty shell is retired and the
    // account attaches to the real one, active at once.
    adoptTenant: async (shellTenantId, realTenantId) => {
      if (!shellTenantId || !realTenantId || shellTenantId === realTenantId) return { ok: false, reason: 'same' };
      const row = await db.select('agency_accounts', `tenant_id=eq.${q(shellTenantId)}&status=eq.pending&select=id,agency_id,display_name`, { single: true }).catch(() => null);
      if (!row) return { ok: false, reason: 'not_found' };
      const dup = await db.select('agency_accounts', `agency_id=eq.${q(row.agency_id)}&tenant_id=eq.${q(realTenantId)}&select=id,status`, { single: true }).catch(() => null);
      if (dup) {
        await db.update('agency_accounts', `id=eq.${q(row.id)}`, { status: 'removed', removed_at: new Date().toISOString() });
        if (dup.status !== 'active') await db.update('agency_accounts', `id=eq.${q(dup.id)}`, { status: 'active' });
      } else {
        await db.update('agency_accounts', `id=eq.${q(row.id)}`, { tenant_id: realTenantId, status: 'active' });
      }
      await db.update('tenants', `id=eq.${q(shellTenantId)}`, { status: 'cancelled' }).catch(() => {});
      const agency = await db.select('agencies', `id=eq.${q(row.agency_id)}&select=name`, { single: true }).catch(() => null);
      await db.insert('ledger', [{ tenant_id: realTenantId, event: 'connection_changed', actor: 'system', summary_text: `${(agency && agency.name) || 'Your agency'} now looks after this account. They see what you see and can propose fixes; nothing changes without an approval.` }], { returning: false }).catch(() => {});
      await log(row.agency_id, null, 'account_connected', { account_id: dup ? dup.id : row.id, display_name: row.display_name, adopted: true });
      return { ok: true, account_id: dup ? dup.id : row.id, agency_id: row.agency_id };
    },
    // Three switches on the row (agency plan move 7): brief-only, register, assigned seat.
    updateAccount: async (agencyId, seatId, accountId, patch) => {
      const acc = await db.select('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}&select=id,display_name`, { single: true }).catch(() => null);
      if (!acc) return { ok: false, reason: 'not_found' };
      const allowed = {};
      if (typeof patch.brief_only === 'boolean') allowed.brief_only = patch.brief_only;
      if (patch.report_register && ['simple', 'technical'].includes(patch.report_register)) allowed.report_register = patch.report_register;
      if (typeof patch.review_reports === 'boolean') allowed.review_reports = patch.review_reports;
      if (typeof patch.client_copy === 'boolean') allowed.client_copy = patch.client_copy;
      if (patch.client_mode && ['shared', 'read_only'].includes(patch.client_mode)) allowed.client_mode = patch.client_mode;
      if ('seat_id' in patch) {
        if (patch.seat_id === null || patch.seat_id === '') allowed.seat_id = null;
        else {
          const seat = await db.select('agency_seats', `id=eq.${q(patch.seat_id)}&agency_id=eq.${q(agencyId)}&status=eq.active&select=id`, { single: true }).catch(() => null);
          if (!seat) return { ok: false, reason: 'seat' };
          allowed.seat_id = patch.seat_id;
        }
      }
      if (!Object.keys(allowed).length) return { ok: false, reason: 'nothing' };
      await db.update('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}`, allowed);
      await log(agencyId, seatId, 'account_updated', { account_id: accountId, display_name: acc.display_name, ...allowed });
      return { ok: true, ...allowed };
    },
    // The account page (agency plan move 8): connection state, the latest
    // report, and what happened to every change after the seat said yes,
    // read from the client's own ledger and receipts.
    accountDetail: async (agencyId, accountId, scope = null) => {
      const acc = await db.select('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}${scopeFilter(scope)}&select=id,tenant_id,display_name,status,brief_only,report_register,seat_id,review_reports,client_mode,client_copy,request_email,request_sent_at,removed_at,created_at,seat:agency_seats(id,name)`, { single: true }).catch(() => null);
      if (!acc) return null;
      const t = acc.tenant_id;
      const [tenant, report, runs, changes, ledger, conn, receipts] = await Promise.all([
        db.select('tenants', `id=eq.${q(t)}&select=business_name,website_url,status,paused_until,timezone`, { single: true }).catch(() => null),
        db.select('reports', `tenant_id=eq.${q(t)}&select=id,type,created_at,summary,review_status&order=created_at.desc&limit=1`, { single: true }).catch(() => null),
        db.select('runs', `tenant_id=eq.${q(t)}&select=id,type,status,started_at,finished_at&order=started_at.desc.nullslast&limit=3`).catch(() => []),
        db.select('changes', `tenant_id=eq.${q(t)}&status=in.(approved,applied,failed,reverted)&select=id,status,applied_at,created_at,summary_text,finding:findings(title,severity,money_impact_monthly_usd)&order=created_at.desc&limit=50`).catch(() => []),
        db.select('ledger', `tenant_id=eq.${q(t)}&select=event,summary_text,created_at,change_id&order=created_at.desc&limit=40`).catch(() => []),
        connectionsFor([t]),
        dashStore(db).receipts(t).catch(() => ({ by_change: {} })),
      ]);
      const connection = conn[t] || 'none';
      const activity = (changes || []).map((c) => {
        const r = receipts.by_change[c.id] || null;
        let state = c.status;
        if (c.status === 'approved') state = connection === 'connected' ? 'applying' : 'waiting';
        else if (r) state = r.state;
        return {
          change_id: c.id,
          title: (c.finding && c.finding.title) || c.summary_text || 'Change',
          severity: c.finding ? c.finding.severity : null,
          money_monthly_usd: c.finding ? c.finding.money_impact_monthly_usd : null,
          state,
          applied_at: c.applied_at || null,
          approved_at: c.created_at,
          line: r ? r.line : null,
          verified_at: r ? r.verified_at : null,
          watch_until: r ? r.watch_until : null,
          can_undo: c.status === 'applied' && !!r && (r.state === 'watching' || r.state === 'verified' || r.state === 'inconclusive'),
        };
      });
      return {
        account: { id: acc.id, tenant_id: t, display_name: acc.display_name, status: acc.status, brief_only: acc.brief_only, report_register: acc.report_register, seat_id: acc.seat_id, seat: acc.seat, review_reports: acc.review_reports !== false, client_mode: acc.client_mode || 'shared', client_copy: !!acc.client_copy, request_email: acc.request_email, request_sent_at: acc.request_sent_at, removed_at: acc.removed_at, created_at: acc.created_at },
        tenant: tenant ? { business_name: tenant.business_name, website_url: tenant.website_url, status: tenant.status, paused_until: tenant.paused_until } : null,
        connection,
        latest_report: report ? { id: report.id, type: report.type, created_at: report.created_at, review_status: report.review_status || null, url: `/r/${report.id}` } : null,
        runs: runs || [],
        activity,
        history: (ledger || []).map((l) => ({ event: l.event, text: l.summary_text, at: l.created_at, change_id: l.change_id })),
      };
    },
    // Undo from the seat (agency plan move 8): the client's own revert path, logged under the seat.
    revertChange: async (agencyId, seatId, accountId, changeId, scope = null) => {
      const acc = await db.select('agency_accounts', `id=eq.${q(accountId)}&agency_id=eq.${q(agencyId)}&status=eq.active${scopeFilter(scope)}&select=tenant_id,brief_only`, { single: true }).catch(() => null);
      if (!acc) return { ok: false, reason: 'not_found' };
      if (acc.brief_only) return { ok: false, reason: 'brief_only' };
      const ch = await db.select('changes', `id=eq.${q(changeId)}&tenant_id=eq.${q(acc.tenant_id)}&select=id`, { single: true }).catch(() => null);
      if (!ch) return { ok: false, reason: 'not_found' };
      const r = await dashStore(db).requestRevert(acc.tenant_id, changeId);
      if (r && r.ok === false) return { ok: false, reason: 'state', error: r.reason };
      await log(agencyId, seatId, 'change_reverted', { change_id: changeId, account_id: accountId });
      return { ok: true };
    },
    billing: async (agencyId, nowIso) => {
      const { monthlyCharge, prorateAdd, cycleFor } = require('../../billing/src/agency-pricing');
      const now = nowIso || new Date().toISOString();
      // Pending is not billable (agency plan move 5): only connected accounts count.
      const [ag, billable] = await Promise.all([
        db.select('agencies', `id=eq.${q(agencyId)}&select=platform_tier,billing_anchor,created_at`, { single: true }),
        db.select('agency_accounts', `agency_id=eq.${q(agencyId)}&status=eq.active&select=id`),
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
    findOrCreateTenantByGoogle: async ({ sub, email, name, preferTenantId = null }) => {
      // One login may own several businesses (fix plan move 12): the last one used opens.
      // Answering an agency's request (agency plan move 5): the business whose
      // website matches the account the agency made wins over recency.
      let existing = await db.select('users', `google_sub=eq.${q(sub)}&select=tenant_id&order=last_seen_at.desc.nullslast&limit=1`, { single: true });
      if (existing && preferTenantId) {
        const [shell, owned] = await Promise.all([
          db.select('tenants', `id=eq.${q(preferTenantId)}&select=website_url`, { single: true }).catch(() => null),
          db.select('users', `google_sub=eq.${q(sub)}&select=tenant_id,tenant:tenants(website_url)`).catch(() => []),
        ]);
        const site = shell && shell.website_url ? String(shell.website_url).toLowerCase() : null;
        const match = site ? (owned || []).find((u) => u.tenant && String(u.tenant.website_url || '').toLowerCase() === site) : null;
        if (match) existing = { tenant_id: match.tenant_id };
      }
      if (existing) {
        await db.update('users', `google_sub=eq.${q(sub)}&tenant_id=eq.${q(existing.tenant_id)}`, { last_seen_at: new Date().toISOString() }).catch(() => {});
        return existing.tenant_id;
      }
      // A client answering an agency's request (fix plan move 14) lands on the
      // account the agency made for them, not on a fresh one.
      if (preferTenantId) {
        const t = await db.select('tenants', `id=eq.${q(preferTenantId)}&select=id`, { single: true }).catch(() => null);
        if (t) {
          await db.insert('users', [{ tenant_id: preferTenantId, google_sub: sub, email, name: name || null }], { returning: false });
          await db.insert('ledger', [{ tenant_id: preferTenantId, event: 'connection_changed', actor: 'system', summary_text: 'Google connected by the account owner, at the agency\'s request.' }], { returning: false }).catch(() => {});
          return preferTenantId;
        }
      }
      const [tenant] = await db.insert('tenants', [{ status: 'active' }]);
      await db.insert('users', [{ tenant_id: tenant.id, google_sub: sub, email, name: name || null }], { returning: false });
      await db.insert('ledger', [{ tenant_id: tenant.id, event: 'connection_changed', actor: 'system', summary_text: 'Account created with Google sign-in.' }], { returning: false }).catch(() => {});
      return tenant.id;
    },
  };
}

module.exports = { workerStore, webStore, executorStore, billingStore, opsStore, dashStore, agencyStore, authStore, managedBy };
