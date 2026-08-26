// Daily light pass judgement — engine-spec §6.2. Not a full audit: four
// checks on a small pulse fetch, each producing at most one alert per day.
// Pure; the poller supplies the pulse and persists/emails the alerts.
//
// judgePulse({ pulse, thresholds, now }) -> [{ kind, severity, title, detail, campaign_ref, trigger_run }]
//   pulse = { days: [{ date, spend_usd, conversions }] (≤ 9 days, ascending), disapproved: [...] }
//   kinds: spend_spike | spend_silence | disapproval | conv_flatline
// Thresholds are config (rule_config row 'pulse.daily' thresholds), defaults here.

const DEFAULTS = {
  spike_multiple: 2.0,        // yesterday ≥ 2× the prior 7-day average
  spike_min_usd: 50,          // …and at least $50, so tiny accounts don't page
  silence_min_avg_usd: 20,    // prior average ≥ $20/day before "silence" means anything
  silence_max_pct: 10,        // yesterday ≤ 10% of the average
  flatline_min_prior_conv: 1, // prior average ≥ 1 conversion/day
  flatline_days: 3,           // …and 3 straight days at zero
};

const r2 = (n) => Math.round(n * 100) / 100;

function judgePulse({ pulse, thresholds = {}, now = Date.now() }) {
  const t = { ...DEFAULTS, ...thresholds };
  const out = [];
  const days = (pulse && pulse.days) || [];
  const today = new Date(now).toISOString().slice(0, 10);
  // "Yesterday" is the last complete day; today's partial row is ignored.
  const complete = days.filter((d) => d.date < today);
  const yesterday = complete[complete.length - 1] || null;
  const prior = complete.slice(0, -1).slice(-7);
  const avgSpend = prior.length ? prior.reduce((s, d) => s + d.spend_usd, 0) / prior.length : 0;
  const avgConv = prior.length ? prior.reduce((s, d) => s + d.conversions, 0) / prior.length : 0;

  if (yesterday && prior.length >= 3) {
    if (yesterday.spend_usd >= t.spike_min_usd && avgSpend > 0 && yesterday.spend_usd >= avgSpend * t.spike_multiple) {
      out.push({
        kind: 'spend_spike', severity: 'warning',
        title: `Spend jumped to $${Math.round(yesterday.spend_usd)} yesterday (usually about $${Math.round(avgSpend)} a day)`,
        detail: { date: yesterday.date, spend_usd: r2(yesterday.spend_usd), avg_7d_usd: r2(avgSpend), multiple: r2(yesterday.spend_usd / avgSpend) },
        campaign_ref: null, trigger_run: true,
      });
    }
    if (avgSpend >= t.silence_min_avg_usd && yesterday.spend_usd <= avgSpend * (t.silence_max_pct / 100)) {
      out.push({
        kind: 'spend_silence', severity: 'warning',
        title: `Ads barely ran yesterday: $${Math.round(yesterday.spend_usd)} against about $${Math.round(avgSpend)} a day`,
        detail: { date: yesterday.date, spend_usd: r2(yesterday.spend_usd), avg_7d_usd: r2(avgSpend) },
        campaign_ref: null, trigger_run: false,
      });
    }
  }

  if (avgConv >= t.flatline_min_prior_conv && complete.length >= t.flatline_days) {
    const tail = complete.slice(-t.flatline_days);
    const spent = tail.reduce((s, d) => s + d.spend_usd, 0);
    if (tail.every((d) => d.conversions === 0) && spent > 0) {
      out.push({
        kind: 'conv_flatline', severity: 'critical',
        title: `No conversions counted for ${t.flatline_days} days while $${Math.round(spent)} was spent`,
        detail: { days: tail.map((d) => d.date), spend_usd: r2(spent), avg_prior_conversions_per_day: r2(avgConv) },
        campaign_ref: null, trigger_run: true,
      });
    }
  }

  const dis = (pulse && pulse.disapproved) || [];
  if (dis.length) {
    const byCampaign = new Map();
    for (const d of dis) byCampaign.set(d.campaign_id, { name: d.campaign_name, count: (byCampaign.get(d.campaign_id) || { count: 0 }).count + 1 });
    const names = [...byCampaign.values()].map((c) => `"${c.name}"`).slice(0, 3).join(', ');
    out.push({
      kind: 'disapproval', severity: dis.length >= 3 ? 'warning' : 'info',
      title: `${dis.length} ad${dis.length === 1 ? '' : 's'} disapproved and sitting silent in ${names}`,
      detail: { ads: dis.length, campaigns: [...byCampaign.keys()] },
      campaign_ref: byCampaign.size === 1 ? [...byCampaign.keys()][0] : null, trigger_run: false,
    });
  }
  return out;
}

module.exports = { judgePulse, DEFAULTS };
