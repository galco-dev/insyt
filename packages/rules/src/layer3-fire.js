// Layer 3 — firing verification (build-doc §3, "the money layer").
// The census of what SHOULD fire (GTM config) against what DID fire (GA4
// Data API event volumes). This is the product's differentiator — the
// configured-but-never-fired findings nobody else surfaces.
//
// Input shapes (assembled at the fetch_ga4_data pipeline stage, §8):
//
// ctx.gtm — Layer 1 container snapshot (gaawe tags carry event_name)
// ctx.ga4Data = {
//   window_days: 30,
//   sessions_30d: 4200,
//   events: [{
//     event_name: 'generate_lead',
//     total_30d: 120,
//     daily: [{ date: 'YYYY-MM-DD', count: n }],   // ≥56 days where available
//     param_null_pct: { value: 0, currency: 0 },   // purchase-class only
//   }],
// }
// ctx.gtmPublishDates — ['YYYY-MM-DD', ...] container version publish dates
// ctx.now — ms epoch, injected
//
// computeVolumeDrops(ga4Data, thresholds) is exported separately: it is the
// Layer 3 join consumed by Layer 1's gtm.version_regression.

const DAY_MS = 86_400_000;
const PURCHASE_CLASS = new Set(['purchase', 'begin_checkout', 'add_payment_info', 'refund']);

function dstr(ms) { return new Date(ms).toISOString().slice(0, 10); }

/** Events the container is configured to send: active GA4 event tags. */
function expectedEvents(gtm) {
  return [...new Set(
    (gtm && gtm.tags ? gtm.tags : [])
      .filter((t) => t.type === 'gaawe' && !t.paused && t.event_name)
      .map((t) => t.event_name),
  )];
}

/**
 * 28-day day-of-week baseline vs the most recent 7 days (§1.7 watches use the
 * same shape). Returns null when there isn't enough history to say anything.
 */
function weekdayBaselineDrop(daily, now, minBaselineDaily) {
  if (!daily || daily.length === 0) return null;
  const byDate = new Map(daily.map((d) => [d.date, d.count]));
  let recent = 0; let expected = 0; let baselineDays = 0;
  for (let i = 1; i <= 7; i++) {
    const day = now - i * DAY_MS;
    recent += byDate.get(dstr(day)) || 0;
    const prior = [];
    for (let w = 1; w <= 4; w++) {
      const d = byDate.get(dstr(day - w * 7 * DAY_MS));
      if (d !== undefined) { prior.push(d); baselineDays += 1; }
    }
    if (prior.length) expected += prior.reduce((a, b) => a + b, 0) / prior.length;
  }
  if (baselineDays < 14 || expected / 7 < minBaselineDaily) return null; // not enough signal
  const dropPct = expected === 0 ? 0 : Math.max(0, Math.round((1 - recent / expected) * 100));
  return { recent_7d: recent, expected_7d: Math.round(expected), drop_pct: dropPct };
}

/**
 * The Layer 3 → Layer 1 join: events whose recent volume collapsed, with the
 * breakpoint date. Fed to gtm.version_regression as ctx.eventVolumeDrops.
 */
function computeVolumeDrops(ga4Data, { min_drop_pct = 50, min_baseline_daily = 1 } = {}, now) {
  const out = [];
  for (const ev of ga4Data.events || []) {
    const base = weekdayBaselineDrop(ev.daily, now, min_baseline_daily);
    if (!base || base.drop_pct < min_drop_pct) continue;
    const lastActive = [...(ev.daily || [])].filter((d) => d.count > 0).map((d) => d.date).sort().pop() || null;
    out.push({ event_name: ev.event_name, drop_pct: base.drop_pct, breakpoint_date: lastActive });
  }
  return out;
}

const rules = [
  {
    rule_id: 'fire.configured_never_fired',
    layer: 3,
    // The census: GTM expected LEFT JOIN GA4 observed = configured-but-silent.
    run({ gtm, ga4Data }) {
      const observed = new Set((ga4Data.events || []).filter((e) => e.total_30d > 0).map((e) => e.event_name));
      const silent = expectedEvents(gtm).filter((e) => !observed.has(e));
      if (silent.length === 0) return [];
      // Cause hint per event: dead/absent trigger → trigger; else tag-or-site
      // (Layer 5's live witness settles tag vs site).
      const triggerIds = new Set((gtm.triggers || []).map((t) => String(t.id)));
      const tagByEvent = new Map(gtm.tags.filter((t) => t.type === 'gaawe' && t.event_name).map((t) => [t.event_name, t]));
      const entities = silent.map((e) => {
        const tag = tagByEvent.get(e);
        const refs = (tag && tag.trigger_ids) || [];
        const deadTrigger = refs.length === 0 || refs.every((id) => !triggerIds.has(String(id)));
        return { kind: 'event', value: e, tag: tag ? tag.name : null, likely_cause: deadTrigger ? 'trigger' : 'tag_or_site' };
      });
      return [{
        category: 'broken_tracking',
        entity_key: silent.sort().join(','),
        evidence: {
          metrics: { configured_events: expectedEvents(gtm).length, silent_events: silent.length },
          window_days: ga4Data.window_days || 30,
          queries: ['ga4/rules/configured_never_fired@v1'],
        },
        payload: {
          locked: true,
          entities,
          fix_detail: `${silent.length} tracked action(s) are set up but have never been recorded — the setup looks done, the data never arrives.`,
        },
        fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'changeset' },
        icon: 'zap-off',
      }];
    },
  },

  {
    rule_id: 'fire.event_stopped',
    layer: 3,
    // Sustained volume then silence; breakpoint correlated to publish dates.
    run({ ga4Data, gtmPublishDates, thresholds, now }) {
      const quietDays = thresholds.quiet_days ?? 7;
      const minPriorDaily = thresholds.min_prior_daily ?? 1;
      const out = [];
      for (const ev of ga4Data.events || []) {
        const daily = ev.daily || [];
        if (!daily.length) continue;
        const cutoff = dstr(now - quietDays * DAY_MS);
        const recent = daily.filter((d) => d.date >= cutoff);
        const prior = daily.filter((d) => d.date < cutoff);
        if (!prior.length) continue;
        const priorAvg = prior.reduce((a, d) => a + d.count, 0) / prior.length;
        const recentTotal = recent.reduce((a, d) => a + d.count, 0);
        if (priorAvg < minPriorDaily || recentTotal > 0) continue;
        const breakpoint = prior.filter((d) => d.count > 0).map((d) => d.date).sort().pop();
        const correlated = (gtmPublishDates || []).find((p) => Math.abs(Date.parse(p) - Date.parse(breakpoint)) <= 2 * DAY_MS) || null;
        out.push({
          category: 'broken_tracking',
          entity_key: ev.event_name,
          evidence: {
            metrics: { prior_daily_avg: Math.round(priorAvg * 10) / 10, quiet_days: quietDays },
            window_days: ga4Data.window_days || 30,
            queries: ['ga4/rules/event_stopped@v1'],
          },
          payload: {
            locked: true,
            entities: [{ kind: 'event', value: ev.event_name, stopped_on: breakpoint, correlated_publish: correlated }],
            fix_detail: correlated
              ? `"${ev.event_name}" stopped being recorded on ${breakpoint} — the same day your tracking setup was changed. Restoring the previous version fixes it.`
              : `"${ev.event_name}" stopped being recorded on ${breakpoint}. No setup change matches the date — the cause is on the site itself.`,
          },
          fix: correlated
            ? { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'changeset' }
            : undefined,
          icon: 'zap-off',
        });
      }
      return out;
    },
  },

  {
    rule_id: 'fire.param_integrity',
    layer: 3,
    // Purchase-class events arriving without value/currency.
    run({ ga4Data, thresholds }) {
      const maxNull = thresholds.max_null_pct ?? 10;
      return (ga4Data.events || [])
        .filter((e) => PURCHASE_CLASS.has(e.event_name) && e.total_30d > 0 && e.param_null_pct)
        .flatMap((e) => {
          const bad = Object.entries(e.param_null_pct).filter(([, pct]) => pct > maxNull);
          if (!bad.length) return [];
          return [{
            category: 'broken_tracking',
            entity_key: e.event_name,
            evidence: {
              metrics: Object.fromEntries(bad.map(([p, pct]) => [`null_${p}_pct`, pct])),
              window_days: ga4Data.window_days || 30,
              queries: ['ga4/rules/param_integrity@v1'],
            },
            payload: {
              locked: true,
              entities: bad.map(([p, pct]) => ({ kind: 'event_param', value: `${e.event_name}.${p}`, null_pct: pct })),
              fix_detail: `Sales are being recorded without the ${bad.map(([p]) => p).join(' and ')} — Google can count that a sale happened but not what it was worth, so bidding can't optimise for revenue.`,
            },
            fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
            icon: 'badge-dollar-sign',
          }];
        });
    },
  },

  {
    rule_id: 'fire.plausibility',
    layer: 3,
    // Events-per-100-sessions outside the configured band. Diagnostic only —
    // bands live in thresholds and tighten as benchmark data accumulates.
    run({ ga4Data, thresholds }) {
      const bands = thresholds.bands || {};
      const sessions = ga4Data.sessions_30d || 0;
      if (sessions < (thresholds.min_sessions ?? 100)) return [];
      const out = [];
      for (const [eventName, band] of Object.entries(bands)) {
        const ev = (ga4Data.events || []).find((e) => e.event_name === eventName);
        const per100 = ((ev ? ev.total_30d : 0) / sessions) * 100;
        const low = band.min_per_100_sessions != null && per100 < band.min_per_100_sessions;
        const high = band.max_per_100_sessions != null && per100 > band.max_per_100_sessions;
        if (!low && !high) continue;
        out.push({
          category: 'suspicious_numbers',
          entity_key: eventName,
          evidence: {
            metrics: { per_100_sessions: Math.round(per100 * 100) / 100, sessions_30d: sessions },
            window_days: ga4Data.window_days || 30,
            queries: ['ga4/rules/plausibility@v1'],
          },
          payload: {
            locked: true,
            entities: [{ kind: 'event', value: eventName, rate_per_100_sessions: Math.round(per100 * 100) / 100 }],
            fix_detail: low
              ? `"${eventName}" is recorded far less often than a site like yours should see — some are probably going uncounted.`
              : `"${eventName}" is recorded implausibly often — something is probably firing it more than once.`,
          },
          icon: 'scale',
        });
      }
      return out;
    },
  },

  {
    rule_id: 'fire.volume_anomaly',
    layer: 3,
    // Recent 7 days vs 28-day day-of-week baseline; severity by magnitude.
    // Feeds §3.7 crash detection and Layer 1's version_regression join.
    run({ ga4Data, thresholds, now }) {
      const critPct = thresholds.critical_drop_pct ?? 80;
      const warnPct = thresholds.warning_drop_pct ?? 50;
      const minBase = thresholds.min_baseline_daily ?? 3;
      const out = [];
      for (const ev of ga4Data.events || []) {
        const base = weekdayBaselineDrop(ev.daily, now, minBase);
        if (!base || base.drop_pct < warnPct) continue;
        if (base.recent_7d === 0) continue; // full silence is fire.event_stopped's finding
        out.push({
          category: 'suspicious_numbers',
          entity_key: ev.event_name,
          severity_override: base.drop_pct >= critPct ? 'critical' : 'warning',
          evidence: {
            metrics: { recent_7d: base.recent_7d, expected_7d: base.expected_7d, drop_pct: base.drop_pct },
            window_days: 35,
            queries: ['ga4/rules/volume_anomaly@v1'],
          },
          payload: {
            locked: true,
            entities: [{ kind: 'event', value: ev.event_name, drop_pct: base.drop_pct }],
            fix_detail: `"${ev.event_name}" is running ${base.drop_pct}% below a normal week — ${base.recent_7d} recorded where about ${base.expected_7d} were expected.`,
          },
          icon: 'trending-down',
        });
      }
      return out;
    },
  },
];

module.exports = { rules, expectedEvents, computeVolumeDrops, weekdayBaselineDrop, PURCHASE_CLASS };
