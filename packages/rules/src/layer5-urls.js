// Layer 5b — final-URL health (agency-specialist audit P1). The verification
// crawl fetches every distinct final URL used by enabled ads and records what
// the money actually lands on. Ads pointing at dead or limping pages burn
// spend invisibly — Google keeps serving them.
//
// ctx.urlHealth = {
//   checks: [{ url, campaign_id, campaign_name, ad_count,
//              status,               // final HTTP status after redirects
//              redirect_hops,        // 0 = direct
//              load_ms,              // main-document load time
//              soft_404 }],          // 200 page that reads as "not found"
//   spend_30d_by_campaign: { [campaign_id]: usd },   // for money attribution
// }
//
// Thresholds from rule_config (15 seed).

const rules = [
  {
    rule_id: 'url.broken',
    layer: 5,
    // Hard failure: 404/410/5xx or soft-404 behind an active ad.
    run({ urlHealth }) {
      const checks = (urlHealth && urlHealth.checks) || [];
      const spend = (urlHealth && urlHealth.spend_30d_by_campaign) || {};
      return checks
        .filter((c) => c.status >= 400 || c.soft_404)
        .map((c) => ({
          category: 'broken_tracking',
          entity_key: `url:${c.url}`,
          money: {
            impact_monthly_usd: Math.round((spend[c.campaign_id] || 0) * 0.5),
            direction: 'waste',
            confidence: 'estimated',
          },
          evidence: { metrics: { status: c.status, soft_404: !!c.soft_404, ad_count: c.ad_count }, window_days: 0, queries: ['crawl/url/broken@v1'] },
          payload: {
            locked: true,
            entities: [{ kind: 'url', value: c.url }],
            campaign_ref: String(c.campaign_id),
            campaign_name: c.campaign_name || null,
            fix_detail: c.soft_404
              ? `${c.ad_count} ad(s) send paid clicks to ${c.url}, which returns a page that says the content is gone. Every click is a paid dead end.`
              : `${c.ad_count} ad(s) send paid clicks to ${c.url}, which returns HTTP ${c.status}. Every click is a paid dead end — pause the ads or fix the URL today.`,
          },
          icon: 'unlink',
        }));
    },
  },

  {
    rule_id: 'url.redirect_chain',
    layer: 5,
    // Multi-hop redirects: latency, tracking-parameter loss, quality-score drag.
    run({ urlHealth, thresholds }) {
      const maxHops = thresholds.max_hops ?? 1;
      const checks = (urlHealth && urlHealth.checks) || [];
      return checks
        .filter((c) => c.status < 400 && !c.soft_404 && (c.redirect_hops || 0) > maxHops)
        .map((c) => ({
          category: 'performance_drag',
          entity_key: `url:${c.url}:redirects`,
          evidence: { metrics: { redirect_hops: c.redirect_hops, max_recommended: maxHops }, window_days: 0, queries: ['crawl/url/redirects@v1'] },
          payload: {
            locked: true,
            entities: [{ kind: 'url', value: c.url }],
            campaign_ref: String(c.campaign_id),
            campaign_name: c.campaign_name || null,
            fix_detail: `${c.url} bounces through ${c.redirect_hops} redirects before landing. Each hop adds latency and can strip tracking parameters — point the ads at the final URL directly.`,
          },
          icon: 'git-branch',
        }));
    },
  },

  {
    rule_id: 'url.slow',
    layer: 5,
    // A slow landing page taxes both conversion rate and quality score.
    run({ urlHealth, thresholds }) {
      const maxMs = thresholds.max_load_ms ?? 4000;
      const checks = (urlHealth && urlHealth.checks) || [];
      return checks
        .filter((c) => c.status < 400 && !c.soft_404 && (c.load_ms || 0) > maxMs)
        .map((c) => ({
          category: 'performance_drag',
          entity_key: `url:${c.url}:slow`,
          evidence: { metrics: { load_ms: c.load_ms, max_recommended_ms: maxMs }, window_days: 0, queries: ['crawl/url/slow@v1'] },
          payload: {
            locked: true,
            entities: [{ kind: 'url', value: c.url }],
            campaign_ref: String(c.campaign_id),
            campaign_name: c.campaign_name || null,
            fix_detail: `${c.url} takes ${(c.load_ms / 1000).toFixed(1)}s to load — paid visitors give up before the page appears, and Google charges more per click for slow landing pages.`,
          },
          icon: 'timer',
        }));
    },
  },
];

module.exports = { rules };
