// Daily light pass pump — engine-spec §6.2. Once a day per linked account:
// fetch the pulse, judge it, write alerts (one per kind per day), email the
// owner (alerts are ALWAYS emailed — the promise stands), and enqueue a
// triggered run when the anomaly warrants a proper look.
//
// pumpDailyPulse({ db, google, queue, now, limit })
//   google.fetchPulse(tenantId) -> pulse           (null google = pump idles)
//   queue.enqueue(name, run)                        (optional; without it the run row stays queued)

const { judgePulse } = require('../../../packages/rules/src/pulse');
const { ownerEmail } = require('./handlers');

const DAY_MS = 86_400_000;

async function pumpDailyPulse({ db, google, queue = null, now = Date.now, limit = 50, thresholds = null }) {
  const q = (s) => encodeURIComponent(s);
  const actions = { checked: 0, alerts: 0, runs: 0, errors: 0 };
  if (!google || !google.fetchPulse) return actions;
  const nowMs = now();
  const cutoff = new Date(nowMs - DAY_MS).toISOString();

  // Linked Ads accounts whose last pulse is older than a day (or never).
  const assets = await db.select('assets', `kind=eq.ads_account&linked=eq.true&select=tenant_id&limit=${limit * 4}`).catch(() => []);
  const tenantIds = [...new Set((assets || []).map((a) => a.tenant_id))];
  if (!tenantIds.length) return actions;
  const states = await db.select('pulse_state', `tenant_id=in.(${tenantIds.map(q).join(',')})&select=tenant_id,last_pulse_at`).catch(() => []);
  const last = new Map((states || []).map((s) => [s.tenant_id, s.last_pulse_at]));
  const due = tenantIds.filter((t) => !last.get(t) || last.get(t) < cutoff).slice(0, limit);
  const th = thresholds || await ruleThresholds(db, 'pulse.daily');

  for (const tenantId of due) {
    actions.checked += 1;
    try {
      const pulse = await google.fetchPulse(tenantId);
      const alerts = judgePulse({ pulse, thresholds: th, now: nowMs });
      const todayStart = new Date(nowMs).toISOString().slice(0, 10);
      const existing = await db.select('alerts', `tenant_id=eq.${q(tenantId)}&created_at=gte.${q(todayStart)}&select=kind`).catch(() => []);
      const seen = new Set((existing || []).map((a) => a.kind));
      let triggerRun = false;
      for (const a of alerts) {
        if (seen.has(a.kind)) continue; // one alert per kind per day
        await db.insert('alerts', [{ tenant_id: tenantId, severity: a.severity, kind: a.kind, title: a.title, detail: a.detail, campaign_ref: a.campaign_ref }], { returning: false });
        actions.alerts += 1;
        await db.insert('emails', [{
          tenant_id: tenantId, template_id: 'daily_alert', to_email: await ownerEmail(db, tenantId), stream: 'transactional', status: 'queued',
          payload: { title: a.title, severity: a.severity, kind: a.kind, app_url: `${process.env.APP_BASE_URL || 'https://app.tryinsyt.com'}/app` },
        }], { returning: false }).catch(() => {});
        await db.insert('ledger', [{ tenant_id: tenantId, event: 'watch_triggered', actor: 'system', summary_text: `Daily check: ${a.title}. We emailed you.` }], { returning: false }).catch(() => {});
        if (a.trigger_run) triggerRun = true;
      }
      if (triggerRun) {
        const key = `triggered:${tenantId}:${todayStart}`;
        const open = await db.select('runs', `tenant_id=eq.${q(tenantId)}&status=in.(queued,running)&select=id&limit=1`).catch(() => []);
        if (!open || !open.length) {
          const [run] = await db.insert('runs', [{ tenant_id: tenantId, type: 'triggered', status: 'queued', idempotency_key: key }]).catch(() => [null]);
          if (run) { actions.runs += 1; if (queue) await queue.enqueue('runs-weekly', run).catch(() => {}); }
        }
      }
      await db.upsert('pulse_state', [{ tenant_id: tenantId, last_pulse_at: new Date(nowMs).toISOString(), last_alerts: alerts.length }], 'tenant_id').catch(() => {});
    } catch (err) {
      actions.errors += 1;
      // Never let one account's failure stall the others; retry next hour.
      await db.upsert('pulse_state', [{ tenant_id: tenantId, last_pulse_at: new Date(nowMs - DAY_MS + 3_600_000).toISOString(), last_error: String(err.message || err).slice(0, 200) }], 'tenant_id').catch(() => {});
    }
  }
  return actions;
}

async function ruleThresholds(db, ruleId) {
  const row = await db.select('rule_config', `rule_id=eq.${encodeURIComponent(ruleId)}&select=thresholds,enabled`, { single: true }).catch(() => null);
  return row && row.enabled !== false ? (row.thresholds || {}) : {};
}

module.exports = { pumpDailyPulse };
