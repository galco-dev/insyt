// Changeset executor — build-doc §4 cross-cutting circuit breakers +
// master §3.7 changeset semantics.
//
//   - ≤30 entities touched per run per tenant
//   - tool error rate >10% in a run aborts the changeset
//   - every write idempotency-keyed (tenant, run, tool, target)
//   - every applied write emits ledger + audit rows with the API result
//
// I/O is injected:
//   api[tool_id](params)  -> { before, after }   (throws on API failure)
//   store = {
//     hasKey(key) -> bool, saveKey(key),                    // idempotency
//     ledger(entry), audit(entry),                          // append-only rows
//   }

const { byId } = require('./catalogue');

const MAX_ENTITIES_PER_RUN = 30;
const ABORT_ERROR_RATE = 0.10;

function idempotencyKey({ tenantId, runId, toolId, target }) {
  return [tenantId, runId, toolId, target].join(':');
}

function targetOf(params) {
  return String(
    params.campaign_id ?? params.tag_id ?? params.conversion_action_id
    ?? params.criterion_id ?? params.property_id ?? params.workspace_id
    ?? params.version_id ?? 'account',
  );
}

/**
 * Apply an approved changeset.
 * @param {object} p { changes: [{id, tool_id, params, summary_text, money_impact_usd}],
 *                     ctx, api, store, tenantId, runId, changesetId, actor }
 * @returns {{ results: [], aborted: boolean, entities_touched: number }}
 */
async function applyChangeset({ changes, ctx, api, store, tenantId, runId, changesetId, actor = 'system' }) {
  const results = [];
  let entities = 0;
  let attempted = 0;
  let failed = 0;
  let aborted = false;

  for (const change of changes) {
    if (aborted) { results.push({ id: change.id, status: 'aborted', reason: 'changeset aborted by error-rate breaker' }); continue; }

    const tool = byId[change.tool_id];
    if (!tool) { results.push({ id: change.id, status: 'failed', reason: `unknown tool ${change.tool_id}` }); continue; }

    // Idempotency: a retried run never applies the same change twice.
    const key = idempotencyKey({ tenantId, runId, toolId: change.tool_id, target: targetOf(change.params || {}) });
    if (store.hasKey(key)) { results.push({ id: change.id, status: 'skipped', reason: 'idempotent replay' }); continue; }

    // Entity circuit breaker.
    const n = tool.entities(change.params || {});
    if (entities + n > MAX_ENTITIES_PER_RUN) {
      results.push({ id: change.id, status: 'failed', reason: `guardrail: run entity budget (${MAX_ENTITIES_PER_RUN}) exhausted` });
      continue;
    }

    // Tool guardrails — pure, checked before any I/O.
    const reason = tool.guard(change.params || {}, ctx);
    if (reason) {
      results.push({ id: change.id, status: 'failed', reason });
      store.audit({ tenant_id: tenantId, event: 'change_guardrail_blocked', detail: { change_id: change.id, tool_id: change.tool_id, reason } });
      continue;
    }

    attempted += 1;
    try {
      const { before, after } = await api[change.tool_id](change.params);
      entities += n;
      store.saveKey(key);
      store.ledger({
        tenant_id: tenantId,
        event: 'fix_applied',
        change_id: change.id,
        actor,
        summary_text: change.summary_text || `Applied ${change.tool_id}`,
        money_impact_usd: change.money_impact_usd ?? null,
      });
      store.audit({
        tenant_id: tenantId,
        event: 'change_applied',
        detail: { change_id: change.id, changeset_id: changesetId, tool_id: change.tool_id, before, after, idempotency_key: key },
      });
      results.push({ id: change.id, status: 'applied', before, after });
    } catch (err) {
      failed += 1;
      store.audit({ tenant_id: tenantId, event: 'change_failed', detail: { change_id: change.id, tool_id: change.tool_id, error: String(err.message || err) } });
      results.push({ id: change.id, status: 'failed', reason: String(err.message || err) });
      if (attempted >= 3 && failed / attempted > ABORT_ERROR_RATE) {
        aborted = true;
        store.audit({ tenant_id: tenantId, event: 'changeset_aborted', detail: { changeset_id: changesetId, failed, attempted } });
      }
    }
  }

  return { results, aborted, entities_touched: entities };
}

module.exports = { applyChangeset, idempotencyKey, MAX_ENTITIES_PER_RUN, ABORT_ERROR_RATE };
