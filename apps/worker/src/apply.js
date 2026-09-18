// Apply loop - turns approved changes into applied ones (§4 executor +
// transports), grouped per tenant into a changeset (the revert unit), with
// the 48h verification watch spawned on success (master §3.7).
//
// scanAndApply({ db, makeApi, makeCtx, now }) - makeApi(tenantId) returns the
// transports map; makeCtx(tenantId) returns the guardrail context. Both are
// injected so this tests offline.

const { applyChangeset } = require('../../../packages/tools/src/executor');
const { executorStore } = require('../../../packages/db/src/stores');
const { planWatch } = require('../../../packages/registry/src/watches');

async function scanAndApply({ db, makeApi, makeCtx, now = Date.now, limit = 50 }) {
  const { fmtMoney } = require('../../../packages/shared/src/money');
const q = (s) => encodeURIComponent(s);
  // changes has no run_id column - the run comes through the finding.
  const rows = await db.select('changes',
    `status=eq.approved&applied_at=is.null&select=id,tenant_id,tool_id,params,finding_id,actor,summary_text,money_impact_usd,change_key,target,category,watch_plan,reverts_change_id,finding:findings(run_id)&order=created_at.asc&limit=${limit}`);
  const approved = (rows || []).map((c) => ({ ...c, run_id: c.run_id || (c.finding && c.finding.run_id) || null }));
  if (!approved.length) return { tenants: 0, applied: 0, failed: 0 };

  const byTenant = new Map();
  for (const c of approved) {
    if (!byTenant.has(c.tenant_id)) byTenant.set(c.tenant_id, []);
    byTenant.get(c.tenant_id).push(c);
  }

  const totals = { tenants: 0, applied: 0, failed: 0 };
  for (const [tenantId, changes] of byTenant) {
    totals.tenants += 1;
    const [changeset] = await db.insert('changesets', [{
      tenant_id: tenantId, run_id: changes[0].run_id, status: 'applied',
      watch_until: new Date(now() + 48 * 3600 * 1000).toISOString(),
    }]);

    let api; let ctx;
    try {
      [api, ctx] = await Promise.all([makeApi(tenantId), makeCtx(tenantId)]);
    } catch (err) {
      // No usable Google connection: leave changes approved for a later pass,
      // and say so once an hour so it never drags in silence (fix plan move 5).
      await db.update('changesets', `id=eq.${q(changeset.id)}`, { status: 'open', revert_reason: `apply deferred: ${err.message}` }).catch(() => {});
      const since = new Date(now() - 3600_000).toISOString();
      const recent = await db.select('audit_log', `tenant_id=eq.${q(tenantId)}&event=eq.apply_deferred&created_at=gte.${q(since)}&select=id&limit=1`, { single: true }).catch(() => null);
      if (!recent) await db.insert('audit_log', [{ tenant_id: tenantId, event: 'apply_deferred', detail: { changes: changes.length, error: String(err.message || err) } }], { returning: false }).catch(() => {});
      continue;
    }

    // Drift (fix plan move 9): a budget the owner already moved since the
    // draft becomes a fresh proposal instead of being moved again.
    const cur = (ctx && ctx.account && ctx.account.currency_code) || 'USD';
    const ready = [];
    for (const c of changes) {
      const p = c.params || {};
      if (c.tool_id === 'ads.adjust_budget' && Number(p.previous_daily_usd) > 0 && typeof ctx.campaign === 'function') {
        const live = ctx.campaign(p.campaign_id);
        const liveBudget = live && live.budget_daily_usd != null ? Number(live.budget_daily_usd) : null;
        if (liveBudget != null && Math.abs(liveBudget - Number(p.previous_daily_usd)) > 0.01) {
          await db.update('changes', `id=eq.${q(c.id)}`, {
            status: 'proposed', changeset_id: null,
            ask_reason: `You changed this to ${fmtMoney(liveBudget, cur)} since we drafted it. Still want ${fmtMoney(p.new_daily_usd, cur)}?`,
            params: { ...p, previous_daily_usd: liveBudget },
            before: { ...(c.before || {}), line: `Runs on ${fmtMoney(liveBudget, cur)} a day today` },
          }).catch(() => {});
          continue;
        }
      }
      ready.push(c);
    }
    if (!ready.length) {
      await db.update('changesets', `id=eq.${q(changeset.id)}`, { status: 'open', revert_reason: 'every change had moved since its draft' }).catch(() => {});
      continue;
    }

    // Ledger actors are never blurred (§7.3): user-approved / autopilot /
    // user_via_chat / system. One changeset per actor group keeps that true.
    const { results } = await applyChangeset({
      changes: ready.map((c) => ({ id: c.id, tool_id: c.tool_id, params: c.params, summary_text: c.summary_text || `Applied ${c.tool_id}`, money_impact_usd: c.money_impact_usd ?? null })),
      ctx, api,
      store: executorStore(db, { tenantId }),
      tenantId, runId: changes[0].run_id, changesetId: changeset.id,
      actor: changes.every((c) => c.actor === changes[0].actor) ? (changes[0].actor || 'user') : 'user',
    });

    for (const r of results) {
      if (r.status === 'applied') {
        totals.applied += 1;
        await db.update('changes', `id=eq.${q(r.id)}`, {
          status: 'applied', applied_at: new Date(now()).toISOString(), changeset_id: changeset.id,
          before: r.before ?? null, after: r.after ?? null,
        }).catch(() => {});
        const ch = changes.find((c) => c.id === r.id);
        if (ch && ch.finding_id) await db.update('findings', `id=eq.${q(ch.finding_id)}`, { status: ch.reverts_change_id ? 'suspect' : 'applied' }).catch(() => {});
        // §4.4 per-change verification watch from the registry plan
        // (7d negatives / 14d budgets / 48h counting), baseline captured at draft time.
        if (ch && ch.watch_plan && ch.watch_plan.kind && !ch.reverts_change_id) {
          const w = planWatch({ id: ch.id, tool_id: ch.tool_id, target: ch.target, change_key: ch.change_key, category: ch.category,
            watch: { kind: ch.watch_plan.kind, days: ch.watch_plan.days }, baseline: ch.watch_plan.baseline || {} }, new Date(now()).toISOString(), now());
          await db.insert('watches', [{ tenant_id: tenantId, ...w }], { returning: false }).catch(() => {});
        }
      } else if (r.status === 'failed') {
        totals.failed += 1;
        await db.update('changes', `id=eq.${q(r.id)}`, { status: 'failed' }).catch(() => {});
        // A receipt for the failure too (fix plan move 9), in plain words, with a retry.
        const ch = changes.find((c) => c.id === r.id);
        await db.insert('ledger', [{
          tenant_id: tenantId, event: 'fix_failed', actor: 'system', change_id: r.id,
          summary_text: `Not applied: "${(ch && ch.summary_text) || (ch && ch.tool_id) || 'a fix'}". ${plainReason(r.reason)}.`,
        }], { returning: false }).catch(() => {});
      } else if (r.status === 'skipped') {
        // Idempotent replay: this exact write already landed under an earlier
        // change row. Mark it applied so the loop stops re-queuing it every tick.
        await db.update('changes', `id=eq.${q(r.id)}`, { status: 'applied', applied_at: new Date(now()).toISOString(), changeset_id: changeset.id }).catch(() => {});
      }
      // 'aborted' rows (error-rate breaker) stay approved for a later pass.
    }

    // 48h verification watch on the changeset (§3.7).
    await db.update('changesets', `id=eq.${q(changeset.id)}`, { status: 'watching' }).catch(() => {});
    await db.insert('watches', [{
      tenant_id: tenantId, kind: 'changeset_verify', target_id: changeset.id, status: 'active',
      schedule: { until: new Date(now() + 48 * 3600 * 1000).toISOString() },
      baseline: { fix_summary: `${changes.length} approved fix${changes.length === 1 ? '' : 'es'}` },
    }], { returning: false }).catch(() => {});
  }
  return totals;
}

// Google's and our own refusals, in the customer register.
function plainReason(reason) {
  const r = String(reason || '').replace(/\s+/g, ' ').trim();
  if (/^guardrail:/i.test(r)) return `We held back: ${r.replace(/^guardrail:\s*/i, '')}`;
  if (/PERMISSION_DENIED|403|permission|not authorized|USER_PERMISSION/i.test(r)) return 'Google says this account does not allow the change from our side';
  if (/policy/i.test(r)) return 'Google says this is under policy review';
  if (/quota|RESOURCE_EXHAUSTED|429|rate/i.test(r)) return 'Google is limiting requests right now; we will try again';
  if (/unknown tool/i.test(r)) return 'This kind of fix is not available yet';
  if (/unknown campaign|NOT_FOUND|404/i.test(r)) return 'Google could not find this in your account any more';
  return r ? `Google said: ${r.slice(0, 140)}` : 'Google did not say why';
}

module.exports = { scanAndApply, plainReason };
