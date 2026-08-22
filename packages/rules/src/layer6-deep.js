// Layer 6 — deep audit rules. The rule families the hand-built deep report
// (The Nail DXB, 20 Aug 2026) proved out, made deterministic. Same engine
// contract as every other layer; severity/thresholds from rule_config
// (16 seed). Measured money comes from real spend sums; anything modelled
// carries money.confidence 'model' and the renderer labels it MODELLED.
//
// Extended input shape (assembled at fetch_ads / demo fixtures; every block
// optional — a rule whose block is absent returns [] and the envelope lists
// the dataset under "not yet examined"):
//
// ctx.adsDeep = {
//   keywords: [{ keyword, match ('exact'|'phrase'|'broad'), campaign_id,
//                ad_group, cost_usd, clicks, conversions, quality_score|null }],
//   hours:   [{ hour (0-23), cost_usd, conversions }],          // 30d window
//   days:    [{ dow (0=Mon..6=Sun), cost_usd, conversions }],   // lifetime or 90d
//   devices: [{ device ('desktop'|'mobile'|'tablet'), cost_usd, conversions }],
//   share:   [{ campaign_id, click_share_pct, exact_match_is_pct,
//               lost_is_budget_pct, invalid_click_rate_pct }],
//   monthly: [{ month ('May'...), campaign_id, cost_usd, clicks, conversions }],
//   assets:  [{ text, type ('headline'|'description'), campaign_id,
//               impressions_30d, pinned }],
//   competitor_names: [..],     // tenant-known competitor names (optional)
//   service_terms: [..],        // tenant service vocabulary (optional)
//   out_of_area_markers: [..],  // place names outside service radius (optional)
//   expected_scripts: ['latin'] // writing systems the account targets on purpose
// }
// ctx.witness.prices = [{ label, amount, currency }]  // crawler-read site menu
// ctx.ads (layer 4 shape) supplies campaigns + account medians.

const dowName = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function accountCpa(rows) {
  const cost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const conv = rows.reduce((s, r) => s + (r.conversions || 0), 0);
  return conv > 0 ? cost / conv : null;
}

function scriptOf(term) {
  if (/[Ѐ-ӿ]/.test(term)) return 'cyrillic';
  if (/[؀-ۿ]/.test(term)) return 'arabic';
  if (/[一-鿿぀-ヿ]/.test(term)) return 'cjk';
  return 'latin';
}

const money = (usd, confidence = 'measured', direction = 'waste') => ({
  impact_monthly_usd: Math.round(usd), direction, confidence,
});

const rules = [
  /* ------------------------------------------------------------- quality */
  {
    rule_id: 'qs.low_average',
    layer: 6,
    // Average quality rating across the highest-volume keywords is low —
    // the account pays a structural per-click premium. Money is a MODEL.
    run({ adsDeep, ads, thresholds }) {
      if (!adsDeep || !adsDeep.keywords) return [];
      const scored = adsDeep.keywords.filter((k) => k.quality_score != null);
      const minScored = thresholds.min_scored_keywords ?? 8;
      if (scored.length < minScored) return [];
      const top = [...scored].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, thresholds.top_n ?? 30);
      const avg = top.reduce((s, k) => s + k.quality_score, 0) / top.length;
      const maxAvg = thresholds.max_avg_qs ?? 5;
      if (avg >= maxAvg) return [];
      const spendMonthly = (ads && ads.spend_30d_usd) || top.reduce((s, k) => s + k.cost_usd, 0) / 3;
      const premiumPct = thresholds.premium_pct ?? 25;
      const dist = {};
      for (const k of top) dist[k.quality_score] = (dist[k.quality_score] || 0) + 1;
      return [{
        category: 'quality',
        entity_key: 'account:qs_average',
        money: money(spendMonthly * (premiumPct / 100), 'model'),
        evidence: {
          metrics: { avg_qs: Math.round(avg * 10) / 10, scored_keywords: top.length, premium_pct: premiumPct },
          window_days: 30,
          queries: ['deep/qs_low_average@v1'],
        },
        payload: { locked: true, entities: [], fix_detail: 'Raise ad-to-search fit on the highest-spend searches; remove the structural per-click premium.', distribution: dist },
        icon: 'gauge',
      }];
    },
  },
  {
    rule_id: 'qs.nonconverter_floor',
    layer: 6,
    // Rock-bottom quality rating + zero conversions + real spend = pay-more-
    // get-nothing clicks. Measured waste; the fix is a pause list.
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.keywords) return [];
      const maxQs = thresholds.max_qs ?? 2;
      const minSpend = thresholds.min_spend_usd ?? 20;
      const hits = adsDeep.keywords.filter((k) => k.quality_score != null
        && k.quality_score <= maxQs && (k.conversions || 0) === 0 && k.cost_usd >= minSpend);
      if (!hits.length) return [];
      const total = hits.reduce((s, k) => s + k.cost_usd, 0);
      return [{
        category: 'wasted_spend',
        entity_key: 'keywords:qs_floor_nonconverters',
        money: money(total / 3),
        evidence: {
          metrics: { keywords: hits.length, spend_90d_usd: Math.round(total) },
          window_days: 90,
          queries: ['deep/qs_nonconverter_floor@v1'],
        },
        payload: {
          locked: true,
          entities: hits.map((k) => ({ value: `${k.keyword} (${k.match})`, spend_usd: k.cost_usd })),
          fix_detail: 'Pause the lowest-rated searches that have never produced a booking.',
        },
        fix: { tool_id: 'ads.pause_keywords', risk: 'low', reversible: true, approval_scope: 'changeset' },
        icon: 'trash',
      }];
    },
  },

  /* ---------------------------------------------------------- scheduling */
  {
    rule_id: 'ads.hour_waste',
    layer: 6,
    // Hours whose cost-per-result runs a multiple of the account's, with
    // real spend share. Surgical: names the hours, measures the overpay.
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.hours || adsDeep.hours.length < 12) return [];
      const acct = accountCpa(adsDeep.hours);
      if (!acct) return [];
      const mult = thresholds.cpa_multiple ?? 2;
      const minSpend = thresholds.min_hour_spend_usd ?? 40;
      const bad = adsDeep.hours.filter((h) => h.cost_usd >= minSpend
        && (h.conversions === 0 ? h.cost_usd / acct >= mult : (h.cost_usd / h.conversions) / acct >= mult));
      if (!bad.length) return [];
      const waste = bad.reduce((s, h) => s + (h.cost_usd - (h.conversions || 0) * acct), 0);
      return [{
        category: 'schedule_waste',
        entity_key: `hours:${bad.map((h) => h.hour).join(',')}`,
        money: money(Math.max(0, waste)),
        evidence: {
          metrics: { hours: bad.map((h) => h.hour), account_cpa_usd: Math.round(acct), worst_hour_cpa_usd: Math.round(Math.max(...bad.map((h) => (h.conversions ? h.cost_usd / h.conversions : h.cost_usd)))) },
          window_days: 30,
          queries: ['deep/hour_waste@v1'],
        },
        payload: {
          locked: true,
          entities: bad.map((h) => ({ value: `${String(h.hour).padStart(2, '0')}:00`, spend_usd: h.cost_usd })),
          fix_detail: 'Exclude the money-losing hours from the ad schedule; every other hour keeps running.',
        },
        icon: 'clock',
      }];
    },
  },
  {
    rule_id: 'ads.dow_waste',
    layer: 6,
    // A weekday whose cost-per-result is a multiple of the best day's.
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.days || adsDeep.days.length < 7) return [];
      const withCpa = adsDeep.days
        .filter((d) => d.cost_usd >= (thresholds.min_day_spend_usd ?? 100))
        .map((d) => ({ ...d, cpa: d.conversions > 0 ? d.cost_usd / d.conversions : Infinity }));
      if (withCpa.length < 4) return [];
      const best = Math.min(...withCpa.map((d) => d.cpa));
      if (!Number.isFinite(best)) return [];
      const mult = thresholds.cpa_multiple ?? 3;
      const bad = withCpa.filter((d) => d.cpa / best >= mult);
      if (!bad.length) return [];
      return bad.map((d) => ({
        category: 'schedule_waste',
        entity_key: `dow:${d.dow}`,
        money: money(Math.max(0, d.cost_usd - (d.conversions || 0) * best) / 3),
        evidence: {
          metrics: { day: dowName[d.dow], day_cpa_usd: Number.isFinite(d.cpa) ? Math.round(d.cpa) : null, best_day_cpa_usd: Math.round(best) },
          window_days: 90,
          queries: ['deep/dow_waste@v1'],
        },
        payload: { locked: true, entities: [{ value: dowName[d.dow], spend_usd: d.cost_usd }], fix_detail: `Exclude ${dowName[d.dow]} from the schedule, or price it into smarter bidding.` },
        icon: 'calendar',
      }));
    },
  },

  /* -------------------------------------------------------------- device */
  {
    rule_id: 'ads.device_cpa_skew',
    layer: 6,
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.devices || adsDeep.devices.length < 2) return [];
      const rows = adsDeep.devices
        .filter((d) => d.cost_usd >= (thresholds.min_device_spend_usd ?? 100))
        .map((d) => ({ ...d, cpa: d.conversions > 0 ? d.cost_usd / d.conversions : Infinity }));
      if (rows.length < 2) return [];
      const best = rows.reduce((a, b) => (a.cpa <= b.cpa ? a : b));
      const mult = thresholds.cpa_multiple ?? 1.5;
      const bad = rows.filter((d) => d !== best && d.cpa / best.cpa >= mult);
      return bad.map((d) => ({
        category: 'targeting',
        entity_key: `device:${d.device}`,
        money: money(Math.max(0, d.cost_usd - (d.conversions || 0) * best.cpa) / 3),
        severity_override: Number.isFinite(d.cpa) ? undefined : 'warning',
        evidence: {
          metrics: { device: d.device, device_cpa_usd: Number.isFinite(d.cpa) ? Math.round(d.cpa) : null, best_device: best.device, best_cpa_usd: Math.round(best.cpa) },
          window_days: 90,
          queries: ['deep/device_cpa_skew@v1'],
        },
        payload: { locked: true, entities: [{ value: d.device, spend_usd: d.cost_usd }], fix_detail: Number.isFinite(d.cpa) ? 'A bid adjustment on the expensive device closes the gap; smart bidding can also price it in once counting is trusted.' : 'This device spends and never books; exclude it or bid it down.' },
        icon: 'device',
      }));
    },
  },

  /* -------------------------------------------------------- market share */
  {
    rule_id: 'ads.growth_headroom',
    layer: 6,
    // Small click share + healthy cost-per-result = the market can fund
    // growth at current efficiency. Direction is growth, money is a MODEL.
    run({ adsDeep, ads, thresholds }) {
      if (!adsDeep || !adsDeep.share || !ads) return [];
      const maxShare = thresholds.max_click_share_pct ?? 15;
      const rows = adsDeep.share.filter((s) => s.click_share_pct != null && s.click_share_pct <= maxShare);
      if (!rows.length) return [];
      const spend = ads.spend_30d_usd || 0;
      return [{
        category: 'growth',
        entity_key: 'account:click_share',
        money: money(spend, 'model', 'growth'),
        evidence: {
          metrics: {
            campaigns: rows.length,
            min_click_share_pct: Math.min(...rows.map((r) => r.click_share_pct)),
            max_click_share_pct: Math.max(...rows.map((r) => r.click_share_pct)),
          },
          window_days: 30,
          queries: ['deep/growth_headroom@v1'],
        },
        payload: { locked: true, entities: rows.map((r) => ({ value: String(r.campaign_id), spend_usd: null })), fix_detail: 'The market holds several times the current click volume at this efficiency; budget, not demand, is the ceiling.' },
        icon: 'trend-up',
      }];
    },
  },
  {
    rule_id: 'ads.lost_is_budget',
    layer: 6,
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.share) return [];
      const minPct = thresholds.min_lost_is_pct ?? 15;
      const rows = adsDeep.share.filter((s) => (s.lost_is_budget_pct || 0) >= minPct);
      return rows.map((r) => ({
        category: 'growth',
        entity_key: `campaign:${r.campaign_id}:lost_is`,
        money: { impact_monthly_usd: 0, direction: 'growth', confidence: 'none' },
        evidence: {
          metrics: { campaign_id: r.campaign_id, lost_is_budget_pct: r.lost_is_budget_pct },
          window_days: 30,
          queries: ['deep/lost_is_budget@v1'],
        },
        payload: { locked: true, entities: [], fix_detail: 'Eligible views are being lost to the budget cap while results run at target; a measured budget raise buys them.' },
        icon: 'trend-up',
      }));
    },
  },
  {
    rule_id: 'ads.invalid_clicks_high',
    layer: 6,
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.share) return [];
      const maxPct = thresholds.max_invalid_pct ?? 8;
      const rows = adsDeep.share.filter((s) => (s.invalid_click_rate_pct || 0) >= maxPct);
      return rows.map((r) => ({
        category: 'quality',
        entity_key: `campaign:${r.campaign_id}:invalid_clicks`,
        money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
        evidence: {
          metrics: { campaign_id: r.campaign_id, invalid_click_rate_pct: r.invalid_click_rate_pct },
          window_days: 30,
          queries: ['deep/invalid_clicks_high@v1'],
        },
        payload: { locked: true, entities: [], fix_detail: 'Automatically filtered clicks are unusually high - a signal of bot or competitor probing. Not billed, worth watching monthly.' },
        icon: 'shield',
      }));
    },
  },

  /* --------------------------------------------------- language + radius */
  {
    rule_id: 'ads.language_demand',
    layer: 6,
    // Searches in another writing system that CONVERT = real demand the
    // account serves by accident. Opportunity, measured.
    run({ adsDeep, ads, thresholds }) {
      if (!adsDeep || !ads || !ads.search_terms) return [];
      const expected = new Set(adsDeep.expected_scripts || ['latin']);
      const foreign = ads.search_terms.filter((t) => !expected.has(scriptOf(t.term)));
      const converters = foreign.filter((t) => (t.conversions_90d || 0) > 0);
      if (converters.length < (thresholds.min_converting_terms ?? 2)) return [];
      const byScript = {};
      for (const t of converters) {
        const s = scriptOf(t.term);
        byScript[s] = byScript[s] || { terms: 0, conv: 0, spend: 0 };
        byScript[s].terms += 1; byScript[s].conv += t.conversions_90d; byScript[s].spend += t.spend_90d_usd || 0;
      }
      return Object.entries(byScript).map(([script, agg]) => ({
        category: 'growth',
        entity_key: `language:${script}`,
        money: { impact_monthly_usd: 0, direction: 'growth', confidence: 'none' },
        evidence: {
          metrics: { script, converting_terms: agg.terms, conversions_90d: agg.conv },
          window_days: 90,
          queries: ['deep/language_demand@v1'],
        },
        payload: { locked: true, entities: converters.filter((t) => scriptOf(t.term) === script).map((t) => ({ value: t.term, spend_usd: t.spend_90d_usd })), fix_detail: 'Real bookings arrive in this language through the side door; dedicated searches and ad copy would own the demand instead of catching it by accident.' },
        icon: 'globe',
      }));
    },
  },
  {
    rule_id: 'ads.competitor_name_drift',
    layer: 6,
    // Broad matching pulls searches for named competitors; they browse,
    // then book where they searched. Measured waste + a ready negative set.
    run({ adsDeep, ads, thresholds }) {
      if (!adsDeep || !adsDeep.competitor_names || !adsDeep.competitor_names.length || !ads || !ads.search_terms) return [];
      const names = adsDeep.competitor_names.map((n) => n.toLowerCase());
      const hits = ads.search_terms.filter((t) => {
        const term = t.term.toLowerCase();
        return names.some((n) => term.includes(n)) && (t.conversions_90d || 0) === 0 && (t.spend_90d_usd || 0) > 0;
      });
      const minSpend = thresholds.min_cluster_spend_90d_usd ?? 30;
      const total = hits.reduce((s, t) => s + t.spend_90d_usd, 0);
      if (!hits.length || total < minSpend) return [];
      return [{
        category: 'wasted_spend',
        entity_key: 'terms:competitor_names',
        money: money(total / 3),
        evidence: {
          metrics: { matched_terms: hits.length, matched_names: [...new Set(hits.flatMap((t) => names.filter((n) => t.term.toLowerCase().includes(n))))].length, spend_90d_usd: Math.round(total) },
          window_days: 90,
          queries: ['deep/competitor_name_drift@v1'],
        },
        payload: {
          locked: true,
          entities: hits.map((t) => ({ value: t.term, spend_usd: t.spend_90d_usd })),
          fix_detail: 'A ready-to-apply exclusion list for every matched competitor name.',
          negative_set: [...new Set(names.filter((n) => hits.some((t) => t.term.toLowerCase().includes(n))))],
        },
        fix: { tool_id: 'ads.add_negative_keywords', risk: 'low', reversible: true, approval_scope: 'changeset' },
        icon: 'users',
      }];
    },
  },
  {
    rule_id: 'ads.out_of_area',
    layer: 6,
    run({ adsDeep, ads, thresholds }) {
      if (!adsDeep || !adsDeep.out_of_area_markers || !adsDeep.out_of_area_markers.length || !ads || !ads.search_terms) return [];
      const markers = adsDeep.out_of_area_markers.map((m) => m.toLowerCase());
      const hits = ads.search_terms.filter((t) => markers.some((m) => t.term.toLowerCase().includes(m)) && (t.conversions_90d || 0) === 0);
      const total = hits.reduce((s, t) => s + (t.spend_90d_usd || 0), 0);
      if (!hits.length || total < (thresholds.min_cluster_spend_90d_usd ?? 20)) return [];
      return [{
        category: 'wasted_spend',
        entity_key: 'terms:out_of_area',
        money: money(total / 3),
        evidence: {
          metrics: { matched_terms: hits.length, spend_90d_usd: Math.round(total) },
          window_days: 90,
          queries: ['deep/out_of_area@v1'],
        },
        payload: { locked: true, entities: hits.map((t) => ({ value: t.term, spend_usd: t.spend_90d_usd })), fix_detail: 'Searches from places you do not serve; excluding them stops the drive-by spend.' },
        fix: { tool_id: 'ads.add_negative_keywords', risk: 'low', reversible: true, approval_scope: 'changeset' },
        icon: 'map',
      }];
    },
  },
  {
    rule_id: 'ads.off_menu_queries',
    layer: 6,
    run({ adsDeep, ads, thresholds }) {
      if (!adsDeep || !adsDeep.service_terms || !adsDeep.service_terms.length || !ads || !ads.search_terms) return [];
      const services = adsDeep.service_terms.map((s) => s.toLowerCase());
      const competitors = (adsDeep.competitor_names || []).map((n) => n.toLowerCase());
      const hits = ads.search_terms.filter((t) => {
        const term = t.term.toLowerCase();
        if ((t.conversions_90d || 0) > 0) return false;
        if (competitors.some((n) => term.includes(n))) return false; // competitor rule owns these
        return !services.some((s) => term.includes(s));
      });
      const total = hits.reduce((s, t) => s + (t.spend_90d_usd || 0), 0);
      if (!hits.length || total < (thresholds.min_cluster_spend_90d_usd ?? 30)) return [];
      return [{
        category: 'wasted_spend',
        entity_key: 'terms:off_menu',
        money: money(total / 3),
        evidence: {
          metrics: { matched_terms: hits.length, spend_90d_usd: Math.round(total) },
          window_days: 90,
          queries: ['deep/off_menu_queries@v1'],
        },
        payload: { locked: true, entities: hits.map((t) => ({ value: t.term, spend_usd: t.spend_90d_usd })), fix_detail: 'Searches for services not on your menu; exclusions stop the spend without touching real demand.' },
        fix: { tool_id: 'ads.add_negative_keywords', risk: 'low', reversible: true, approval_scope: 'changeset' },
        icon: 'scissors',
      }];
    },
  },

  /* ------------------------------------------------------ site truth */
  {
    rule_id: 'truth.price_mismatch',
    layer: 6,
    // The ad promises a price the website contradicts. Reputation-critical:
    // price-intent clicks arrive, the till tells a different story.
    run({ adsDeep, witness }) {
      if (!adsDeep || !adsDeep.assets || !witness || !witness.prices || !witness.prices.length) return [];
      const priceRe = /(?:AED|USD|\$|€|£)\s?(\d{2,5})/i;
      const out = [];
      for (const a of adsDeep.assets) {
        const m = priceRe.exec(a.text || '');
        if (!m) continue;
        const claimed = Number(m[1]);
        const matched = witness.prices.find((p) => {
          const label = (p.label || '').toLowerCase();
          return label && (a.text || '').toLowerCase().split(/\s+/).some((w) => w.length > 3 && label.includes(w));
        });
        if (!matched || Math.abs(matched.amount - claimed) / matched.amount <= 0.1) continue;
        out.push({
          category: 'truth',
          entity_key: `asset:${a.text.slice(0, 40)}`,
          money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
          severity_override: 'critical',
          evidence: {
            metrics: { claimed_price: claimed, site_price: matched.amount, site_label: matched.label },
            window_days: 0,
            queries: ['deep/price_mismatch@v1'],
          },
          payload: { locked: true, entities: [{ value: a.text, spend_usd: null }], fix_detail: 'Fix the ad wording the same day; price-intent clicks are arriving on a promise the website contradicts.' },
          icon: 'alert',
        });
      }
      return out;
    },
  },

  /* --------------------------------------------------------------- trends */
  {
    rule_id: 'trend.cpc_escalation',
    layer: 6,
    // A campaign's per-click cost multiplied across months while volume held
    // or rose: bidder-driven escalation, not the market.
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.monthly) return [];
      const byCampaign = {};
      for (const m of adsDeep.monthly) {
        (byCampaign[m.campaign_id] = byCampaign[m.campaign_id] || []).push(m);
      }
      const mult = thresholds.cpc_multiple ?? 2.5;
      const out = [];
      for (const [cid, rows] of Object.entries(byCampaign)) {
        if (rows.length < 4) continue;
        const cpcs = rows.map((r) => (r.clicks > 0 ? r.cost_usd / r.clicks : null)).filter((v) => v != null);
        if (cpcs.length < 4) continue;
        const first = cpcs[0]; const last = cpcs[cpcs.length - 1];
        if (first <= 0 || last / first < mult) continue;
        out.push({
          category: 'trend',
          entity_key: `campaign:${cid}:cpc_escalation`,
          money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
          evidence: {
            metrics: { campaign_id: cid, first_cpc_usd: Math.round(first * 100) / 100, last_cpc_usd: Math.round(last * 100) / 100, periods: rows.length },
            window_days: rows.length * 30,
            queries: ['deep/cpc_escalation@v1'],
          },
          payload: { locked: true, entities: [], fix_detail: 'Per-click cost multiplied while reach grew - the uncapped bidder escalated by design. A cost target caps it at the efficient level.', series: cpcs },
          icon: 'trend-up',
        });
      }
      return out;
    },
  },
  {
    rule_id: 'trend.cpa_regression',
    layer: 6,
    // Cost-per-result jumped off its matured floor in the latest period -
    // usually a counting change or creative reset relearning.
    run({ adsDeep, thresholds }) {
      if (!adsDeep || !adsDeep.monthly) return [];
      const byPeriod = {};
      for (const m of adsDeep.monthly) {
        byPeriod[m.month] = byPeriod[m.month] || { cost: 0, conv: 0, order: Object.keys(byPeriod).length };
        byPeriod[m.month].cost += m.cost_usd; byPeriod[m.month].conv += m.conversions;
      }
      const periods = Object.entries(byPeriod)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([label, v]) => ({ label, cpa: v.conv > 0 ? v.cost / v.conv : null }))
        .filter((p) => p.cpa != null);
      if (periods.length < 4) return [];
      const last = periods[periods.length - 1];
      const floor = Math.min(...periods.slice(0, -1).map((p) => p.cpa));
      const mult = thresholds.cpa_multiple ?? 1.5;
      if (last.cpa / floor < mult) return [];
      return [{
        category: 'trend',
        entity_key: 'account:cpa_regression',
        money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
        evidence: {
          metrics: { latest_period: last.label, latest_cpa_usd: Math.round(last.cpa), matured_floor_usd: Math.round(floor) },
          window_days: periods.length * 30,
          queries: ['deep/cpa_regression@v1'],
        },
        payload: { locked: true, entities: [], fix_detail: 'Cost-per-result left its matured floor in the latest stretch; the fix is usually restoring the counting or letting the relearn finish with a cost target.', series: periods.map((p) => ({ label: p.label, cpa: Math.round(p.cpa) })) },
        icon: 'activity',
      }];
    },
  },
];

module.exports = { rules, scriptOf, accountCpa };
