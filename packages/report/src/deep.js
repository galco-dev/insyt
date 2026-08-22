// Deep-report section assembler — turns the deep data blocks (ctx.adsDeep +
// witness + findings + the change ledger) into the envelope's `deep` object:
// chart-ready series, tables, the execution register, and the "not yet
// examined" honesty list. Numbers are summed HERE, in code; the renderer and
// the app consume this object verbatim. Anything derived by allocation
// rather than measurement is flagged modelled: true and renders labelled.

const DATASET_LABELS = {
  keywords: 'Search-level performance with quality ratings',
  hours: 'Hour-of-day spend and results',
  days: 'Day-of-week spend and results',
  devices: 'Phone vs computer results',
  share: 'Market share and growth headroom',
  monthly: 'Month-by-month cost history',
  assets: 'Ad wording performance',
  prices: 'Website price menu cross-check',
  demographics: 'Age and gender breakdown',
  conversion_lag: 'How long bookings take to land',
  change_history: 'Account change history',
  seasonality: 'Seasonal patterns (needs a longer history)',
};

function assembleDeep({ adsDeep = null, witness = null, findings = [], changes = [], extraUnexamined = [] } = {}) {
  const d = adsDeep || {};
  const deep = {};
  const have = (k) => Array.isArray(d[k]) && d[k].length > 0;

  /* ---- money picture: actual vs optimized (waste removed) per period ---- */
  if (have('monthly')) {
    const periods = [];
    for (const m of d.monthly) {
      let p = periods.find((x) => x.label === m.month);
      if (!p) { p = { label: m.month, actual: 0 }; periods.push(p); }
      p.actual += m.cost_usd;
    }
    const measuredWaste = findings
      .filter((f) => f.money && f.money.direction === 'waste' && f.money.confidence === 'measured'
        && (f.status === 'open' || f.status === 'approved' || f.status === 'suspect'))
      .reduce((s, f) => s + (f.money.impact_monthly_usd || 0), 0);
    const totalActual = periods.reduce((s, p) => s + p.actual, 0) || 1;
    deep.money_picture = {
      modelled: true, // allocation of measured monthly waste across periods
      x_labels: periods.map((p) => p.label),
      actual: periods.map((p) => Math.round(p.actual)),
      optimized: periods.map((p) => Math.round(p.actual - measuredWaste * (p.actual / totalActual))),
      saved: periods.map((p) => Math.round(measuredWaste * (p.actual / totalActual))),
      measured_waste_monthly: Math.round(measuredWaste),
    };

    /* ---- cost-per-result curve across the same periods ---- */
    const withConv = [];
    for (const m of d.monthly) {
      let p = withConv.find((x) => x.label === m.month);
      if (!p) { p = { label: m.month, cost: 0, conv: 0 }; withConv.push(p); }
      p.cost += m.cost_usd; p.conv += m.conversions;
    }
    const curve = withConv.filter((p) => p.conv > 0).map((p) => ({ label: p.label, cpa: Math.round(p.cost / p.conv) }));
    if (curve.length >= 3) {
      const regression = findings.find((f) => f.rule_id === 'trend.cpa_regression');
      deep.cpa_curve = {
        x_labels: curve.map((p) => p.label),
        values: curve.map((p) => p.cpa),
        floor: Math.min(...curve.map((p) => p.cpa)),
        regression_period: regression ? regression.evidence.metrics.latest_period : null,
      };
    }
  }

  /* ---- leak ledger: per-campaign recovered / calendar / active ---- */
  const leakFindings = findings.filter((f) => f.money && f.money.direction === 'waste' && f.money.impact_monthly_usd > 0);
  if (leakFindings.length || changes.length) {
    const recovered = changes
      .filter((c) => c.status === 'applied' && c.recovered_usd)
      .reduce((s, c) => s + c.recovered_usd, 0);
    const calendar = leakFindings.filter((f) => f.category === 'schedule_waste').reduce((s, f) => s + f.money.impact_monthly_usd, 0);
    const active = leakFindings.filter((f) => f.category !== 'schedule_waste' && f.money.confidence === 'measured' && f.status !== 'applied').reduce((s, f) => s + f.money.impact_monthly_usd, 0);
    deep.leak_ledger = {
      totals: { recovered_usd: Math.round(recovered), calendar_usd: Math.round(calendar), active_usd: Math.round(active) },
      rows: leakFindings.map((f) => ({
        label: f.title || f.rule_id,
        cost_usd: f.money.impact_monthly_usd,
        modelled: f.money.confidence === 'model',
        severity: f.severity,
        window_days: f.evidence ? f.evidence.window_days : null,
        fix: (f.payload && f.payload.fix_detail) || '',
        status: f.status,
      })),
    };
  }

  /* ---- quality rating distribution ---- */
  const qsFinding = findings.find((f) => f.rule_id === 'qs.low_average');
  if (qsFinding && qsFinding.payload && qsFinding.payload.distribution) {
    const dist = qsFinding.payload.distribution;
    deep.qs_distribution = {
      avg: qsFinding.evidence.metrics.avg_qs,
      premium_monthly_usd: qsFinding.money.impact_monthly_usd,
      modelled: true,
      bins: Object.keys(dist).sort((a, b) => a - b).map((qs) => ({
        label: `QS ${qs}`, count: dist[qs], status: qs <= 3 ? 'critical' : qs <= 5 ? 'warning' : 'success',
      })),
    };
  }

  /* ---- hour profile ---- */
  if (have('hours')) {
    const hourFinding = findings.find((f) => f.rule_id === 'ads.hour_waste');
    deep.hour_profile = {
      hours: d.hours.map((h) => ({ hour: h.hour, spend: Math.round(h.cost_usd), cpa: h.conversions > 0 ? Math.round(h.cost_usd / h.conversions) : null })),
      flagged: hourFinding ? hourFinding.evidence.metrics.hours : [],
    };
  }

  /* ---- headroom ---- */
  if (have('share')) {
    deep.headroom = {
      rows: d.share.map((s) => ({
        campaign_id: s.campaign_id,
        label: s.campaign_name || String(s.campaign_id),
        pct: Math.round((s.click_share_pct || 0) * 10) / 10,
        exact_match_is_pct: s.exact_match_is_pct ?? null,
        lost_is_budget_pct: s.lost_is_budget_pct ?? null,
        invalid_click_rate_pct: s.invalid_click_rate_pct ?? null,
      })),
    };
  }

  /* ---- keyword table (locked detail) ---- */
  if (have('keywords')) {
    deep.keyword_table = {
      locked: true,
      rows: d.keywords.map((k) => {
        const cpa = k.conversions > 0 ? Math.round((k.cost_usd / k.conversions) * 10) / 10 : null;
        const status = k.conversions > 0 && (k.quality_score == null || k.quality_score >= 5) ? 'good'
          : (k.conversions || 0) === 0 && (k.quality_score != null && k.quality_score <= 2) ? 'serious' : 'watch';
        return {
          keyword: k.keyword, match: k.match, group: k.ad_group,
          cost_usd: Math.round(k.cost_usd), clicks: k.clicks, conversions: k.conversions,
          cpa_usd: cpa, quality: k.quality_score, status,
        };
      }),
    };
  }

  /* ---- conversion mix ---- */
  if (have('conversion_mix')) {
    const total = d.conversion_mix.reduce((s, r) => s + r.count, 0) || 1;
    deep.conversion_mix = d.conversion_mix.map((r) => ({
      signal: r.signal, count: r.count, share_pct: Math.round((r.count / total) * 100), note: r.note || '',
    }));
  }

  /* ---- ad copy assets (locked detail) ---- */
  if (have('assets')) {
    deep.copy_assets = {
      locked: true,
      rows: d.assets.map((a) => ({
        text: a.text, type: a.type, impressions: a.impressions_30d ?? null, pinned: !!a.pinned,
        status: a.status || (a.impressions_30d > 300 ? 'good' : a.impressions_30d > 0 ? 'watch' : 'serious'),
        insight: a.insight || '',
      })),
    };
  }

  /* ---- execution register (locked detail) ---- */
  if (changes.length) {
    deep.execution_register = {
      locked: true,
      rows: changes.map((c) => ({
        id: c.id, kind: c.kind, item: c.item, target: c.target || '',
        rationale: c.rationale || '', executor: c.executor || 'Insyt',
        status: c.status, verified_at: c.verified_at || null,
      })),
    };
  }

  /* ---- what is not yet examined, said plainly ---- */
  const unexamined = [];
  for (const key of ['keywords', 'hours', 'days', 'devices', 'share', 'monthly', 'assets']) {
    if (!have(key)) unexamined.push(DATASET_LABELS[key]);
  }
  if (!witness || !witness.prices || !witness.prices.length) unexamined.push(DATASET_LABELS.prices);
  for (const extra of extraUnexamined) unexamined.push(DATASET_LABELS[extra] || extra);
  deep.unexamined = unexamined;

  return deep;
}

module.exports = { assembleDeep, DATASET_LABELS };
