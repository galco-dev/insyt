// Audit pipeline stage runner — build-doc §8.
// One job per run; stages as checkpointed steps (master §3.5):
//   fetch_gtm → fetch_ga4_config → fetch_ga4_data → fetch_ads → live_witness
//   → rules_pass → money_math → narration → render → deliver
//
// Guarantees, all enforced here:
//   - checkpoint written to runs.checkpoint after every stage → re-entry skips
//     completed stages (idempotent resume after a crash or deploy)
//   - per-stage timeout; failure → retry ×2 → stage marked failed → run
//     CONTINUES degraded with degraded_reasons[] (live-witness failure never
//     blocks config layers)
//   - real progress events per stage (SSE consumers get actual stage names
//     and counts — never fake progress)
//
// Stages are injected as { name, required?, run(runCtx) -> patch } — the §8
// stage implementations live in stages.js and wire the existing packages.

const STAGE_RETRIES = 2;
const DEFAULT_STAGE_TIMEOUT_MS = 120_000;

function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stage timeout: ${label} (${ms}ms)`)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

/**
 * Run (or resume) a pipeline.
 * @param {object} p
 *   p.run        { id, tenant_id, type, checkpoint }  — checkpoint may hold prior progress
 *   p.stages     ordered stage list
 *   p.store      { saveCheckpoint(runId, checkpoint), finishRun(runId, patch) }
 *   p.emit       (event) => void — progress events for the SSE bridge
 *   p.timeoutMs  per-stage timeout override
 * @returns {{ status: 'complete'|'degraded'|'failed', degraded_reasons: [], ctx }}
 */
async function runPipeline({ run, stages, store, emit = () => {}, timeoutMs = DEFAULT_STAGE_TIMEOUT_MS }) {
  const checkpoint = { completed: {}, ...(run.checkpoint || {}) };
  const degradedReasons = [...(checkpoint.degraded_reasons || [])];
  // Stage outputs accumulate on ctx; resumed stages restore from checkpoint.
  const ctx = { run, ...(checkpoint.ctx || {}) };

  for (const stage of stages) {
    if (checkpoint.completed[stage.name]) {
      emit({ stage: stage.name, state: 'skipped_resume' });
      continue;
    }
    emit({ stage: stage.name, state: 'started' });

    let lastErr = null;
    let patch = null;
    for (let attempt = 0; attempt <= STAGE_RETRIES; attempt++) {
      try {
        patch = await withTimeout(stage.run(ctx), stage.timeoutMs || timeoutMs, stage.name);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        emit({ stage: stage.name, state: 'retry', attempt: attempt + 1, error: String(err.message || err) });
      }
    }

    if (lastErr) {
      // A required stage failing sinks the run; anything else degrades it.
      if (stage.required) {
        // Record WHY before sinking the run - a fatal with no reason is undebuggable.
        degradedReasons.push(`${stage.name} (fatal): ${String(lastErr.message || lastErr)}`);
        checkpoint.completed[stage.name] = 'failed';
        checkpoint.degraded_reasons = degradedReasons;
        checkpoint.fatal = { stage: stage.name, error: String(lastErr.stack || lastErr.message || lastErr).slice(0, 2000) };
        await store.saveCheckpoint(run.id, checkpoint).catch(() => {});
        await store.finishRun(run.id, { status: 'failed', finished_at: new Date().toISOString() });
        emit({ stage: stage.name, state: 'failed_fatal' });
        return { status: 'failed', degraded_reasons: degradedReasons, ctx };
      }
      degradedReasons.push(`${stage.name}: ${String(lastErr.message || lastErr)}`);
      checkpoint.completed[stage.name] = 'failed';
      emit({ stage: stage.name, state: 'failed_degraded' });
    } else {
      Object.assign(ctx, patch || {});
      checkpoint.completed[stage.name] = 'ok';
      emit({ stage: stage.name, state: 'done', ...(patch && patch._progress ? { progress: patch._progress } : {}) });
    }

    checkpoint.degraded_reasons = degradedReasons;
    checkpoint.ctx = serializableCtx(ctx);
    await store.saveCheckpoint(run.id, checkpoint);
  }

  const status = degradedReasons.length ? 'degraded' : 'complete';
  await store.finishRun(run.id, { status, finished_at: new Date().toISOString() });
  emit({ stage: '_run', state: status });
  return { status, degraded_reasons: degradedReasons, ctx };
}

// Checkpoints must survive JSON round-trips; drop non-serializable values.
function serializableCtx(ctx) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'run' || typeof v === 'function') continue;
    try { JSON.stringify(v); out[k] = v; } catch { /* skip */ }
  }
  return out;
}

module.exports = { runPipeline, STAGE_RETRIES, DEFAULT_STAGE_TIMEOUT_MS };
