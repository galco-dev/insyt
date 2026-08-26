// Learning-layer telemetry writer — engine-spec §8 / §11. Backend-only.
// Every write is best-effort (never throws into a request or a pipeline
// stage) and bumps the stream's heartbeat, because a silent stream is an
// incident (§11.9). One factory over the PostgREST client.
//
//   const tel = createTelemetry({ db });
//   await tel.event({ tenantId, name: 'screen.view', props: { screen: 'home' } });
//   await tel.dismissal({ tenantId, changeId, findingId, ruleId, reasonTap, expandedFirst });
//   await tel.unanswered({ tenantId, source: 'composer', text });
//   await tel.draftEdit({ tenantId, artifactKind, artifactId, drafted, shipped, modelVersion });
//   await tel.modelUsage({ tenantId, inputTokens, outputTokens, costUsd });
//   await tel.assetSnapshot({ tenantId, runId, month, assets });

const REASON_TAPS = new Set(['wrong', 'not_now', 'did_myself', 'dont_touch', 'other']);
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/; // e.g. screen.view, approval.approve

function monthStart(d = new Date()) {
  return `${d.toISOString().slice(0, 7)}-01`;
}

/** Cost of one model call from token counts; prices are config (per MTok). */
function modelCost({ inputTokens = 0, outputTokens = 0, cachedTokens = 0, priceIn, priceOut, priceCached = null }) {
  if (priceIn == null || priceOut == null) return 0; // unpriced = counted, not charged
  const cachedRate = priceCached == null ? priceIn * 0.1 : priceCached;
  return Math.round((((inputTokens - cachedTokens) * priceIn + cachedTokens * cachedRate + outputTokens * priceOut) / 1_000_000) * 10_000) / 10_000;
}

/** Minimal line diff for draft_edits.diff — enough to learn from, cheap to store. */
function textDiff(drafted, shipped) {
  const a = String(drafted || ''); const b = String(shipped || '');
  return {
    changed: a !== b,
    drafted_len: a.length, shipped_len: b.length,
    // crude edit distance proxy: shared prefix + suffix
    kept_prefix: (() => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; })(),
    kept_suffix: (() => { let i = 0; while (i < a.length - 0 && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; })(),
  };
}

function createTelemetry({ db, log = () => {} }) {
  const q = (s) => encodeURIComponent(s);

  async function beat(stream) {
    try {
      const row = await db.select('telemetry_heartbeat', `stream=eq.${q(stream)}&select=stream,last_write_at,writes_today`, { single: true }).catch(() => null);
      const today = new Date().toISOString().slice(0, 10);
      const sameDay = row && String(row.last_write_at || '').slice(0, 10) === today;
      await db.upsert('telemetry_heartbeat', [{
        stream, last_write_at: new Date().toISOString(), writes_today: sameDay ? (row.writes_today || 0) + 1 : 1,
      }], 'stream');
    } catch (e) { log(`heartbeat ${stream} failed: ${e.message}`); }
  }

  async function safe(stream, fn) {
    try { await fn(); await beat(stream); return true; } catch (e) { log(`telemetry ${stream} failed: ${e.message}`); return false; }
  }

  return {
    event: ({ tenantId = null, agencyId = null, seatId = null, name, props = {}, source = 'app', sessionKey = null }) => {
      if (!EVENT_NAME.test(String(name || ''))) return Promise.resolve(false);
      return safe('events', () => db.insert('events', [{
        tenant_id: tenantId, agency_id: agencyId, seat_id: seatId, name, props: props && typeof props === 'object' ? props : {}, source, session_key: sessionKey,
      }], { returning: false }));
    },
    dismissal: ({ tenantId, changeId = null, findingId = null, ruleId = null, reasonTap = null, expandedFirst = false, actor = 'user' }) =>
      safe('dismissals', () => db.insert('dismissals', [{
        tenant_id: tenantId, change_id: changeId, finding_id: findingId, rule_id: ruleId,
        reason_tap: REASON_TAPS.has(reasonTap) ? reasonTap : null, expanded_first: !!expandedFirst, actor,
      }], { returning: false })),
    unanswered: ({ tenantId = null, source, text, clusterId = null }) =>
      safe('unanswered', () => db.insert('unanswered_log', [{ tenant_id: tenantId, source, text: String(text || '').slice(0, 2000), cluster_id: clusterId }], { returning: false })),
    draftEdit: ({ tenantId, artifactKind, artifactId = null, drafted, shipped, modelVersion = null }) =>
      safe('draft_edits', () => db.insert('draft_edits', [{
        tenant_id: tenantId, artifact_kind: artifactKind, artifact_id: artifactId, drafted: String(drafted || ''), shipped: String(shipped || ''),
        diff: textDiff(drafted, shipped), model_version: modelVersion,
      }], { returning: false })),
    // Monthly per-tenant aggregate (§9.9). Read-modify-write on the (tenant, month) row.
    modelUsage: ({ tenantId, inputTokens = 0, outputTokens = 0, costUsd = 0, now = new Date() }) =>
      safe('model_usage', async () => {
        const month = monthStart(now);
        const row = await db.select('model_usage', `tenant_id=eq.${q(tenantId)}&month=eq.${month}&select=calls,input_tokens,output_tokens,cost_usd`, { single: true }).catch(() => null);
        await db.upsert('model_usage', [{
          tenant_id: tenantId, month,
          calls: (row ? row.calls : 0) + 1,
          input_tokens: (row ? Number(row.input_tokens) : 0) + inputTokens,
          output_tokens: (row ? Number(row.output_tokens) : 0) + outputTokens,
          cost_usd: Math.round(((row ? Number(row.cost_usd) : 0) + costUsd) * 10_000) / 10_000,
          updated_at: now.toISOString(),
        }], 'tenant_id,month');
      }),
    // RSA asset labels per account per month (§11.3). Idempotent per month.
    assetSnapshot: ({ tenantId, runId = null, month = monthStart(), assets = [] }) =>
      safe('asset_perf', async () => {
        const rows = (assets || []).filter((a) => a && a.text && (a.type === 'headline' || a.type === 'description')).map((a) => ({
          tenant_id: tenantId, run_id: runId, month, campaign_ref: a.campaign_id ? String(a.campaign_id) : null,
          asset_type: a.type, text: String(a.text).slice(0, 200), performance_label: a.performance_label || null,
          impressions_30d: Math.round(a.impressions_30d || 0), pinned: !!a.pinned,
        }));
        if (!rows.length) return;
        await db.upsert('asset_perf_snapshots', rows, 'tenant_id,month,campaign_ref,asset_type,text');
      }),
    beat,
  };
}

module.exports = { createTelemetry, modelCost, textDiff, monthStart, REASON_TAPS };
