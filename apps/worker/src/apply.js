// Apply loop — turns approved changes into applied ones (§4 executor +
// transports), grouped per tenant into a changeset (the revert unit), with
// the 48h verification watch spawned on success (master §3.7).
//
// scanAndApply({ db, makeApi, makeCtx, now }) — makeApi(tenantId) returns the
// transports map; makeCtx(tenantId) returns the guardrail context. Both are
// injected so this tests offline.

const { applyChangeset } = require('../../../packages/tools/src/executor');
const { executorStore } = require('../../../packages/db/src/stores');

async function scanAndApply({ db, makeApi, makeCtx, now = Date.now, limit = 50 }) {
  const q = (s) => encodeURIComponent(s);
  // changes has no run_id column — the run comes through the finding.
  const rows = await db.select('changes',
    `status=eq.approved&applied_at=is.null&select=id,tenant_id,tool_id,params,finding_id,finding:findings(run_id)&order=created_at.asc&limit=${limit}`);
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
      // No usable Google connection — leave changes approved for a later pass.
      await db.update('changesets', `id=eq.${q(changeset.id)}`, { status: 'open', revert_reason: `apply deferred: ${err.message}` }).catch(() => {});
      continue;
    }

    const { results } = await applyChangeset({
      changes: changes.map((c) => ({ id: c.id, tool_id: c.tool_id, params: c.params, summary_text: `Applied ${c.tool_id}` })),
      ctx, api,
      store: executorStore(db, { tenantId }),
      tenantId, runId: changes[0].run_id, changesetId: changeset.id,
    });

    for (const r of results) {
      if (r.status === 'applied') {
        totals.applied += 1;
        await db.update('changes', `id=eq.${q(r.id)}`, {
          status: 'applied', applied_at: new Date(now()).toISOString(), changeset_id: changeset.id,
          before: r.before ?? null, after: r.after ?? null,
        }).catch(() => {});
        const ch = changes.find((c) => c.id === r.id);
        if (ch) await db.update('findings', `id=eq.${q(ch.finding_id)}`, { status: 'applied' }).catch(() => {});
      } else if (r.status === 'failed') {
        totals.failed += 1;
        await db.update('changes', `id=eq.${q(r.id)}`, { status: 'failed' }).catch(() => {});
      }
      // 'skipped' (idempotent replay) and 'aborted' rows stay as they are.
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

module.exports = { scanAndApply };
