// Layer 5 — live witness (build-doc §3, §5 verification crawl).
// The crawler renders the real site and watches what actually loads and
// fires. This layer closes the loop the config layers can't: a pristine
// GTM setup means nothing if the site never loads it.
//
// Input: ctx.witness — verification-crawl output (§5, crawler package):
// {
//   pages: [{ url, is_homepage, ok,
//             gtm_containers_seen: ['GTM-XXXX'],
//             collect_measurement_ids: ['G-...'] }],   // GA4 collect requests captured
// }
// ctx.gtm — Layer 1 snapshot (container_public_id = what SHOULD be there)
// ctx.linkedMeasurementIds — G-IDs of the linked property's streams
// ctx.previouslyVerified — bool: tag was seen alive on a prior run (heartbeat)

const okPages = (w) => (w.pages || []).filter((p) => p.ok);

const rules = [
  {
    rule_id: 'live.container_missing',
    layer: 5,
    // Config pristine, site silent: the container appears on no rendered page.
    run({ witness, gtm }) {
      const expected = gtm && gtm.container_public_id;
      if (!expected || okPages(witness).length === 0) return [];
      const seenAnywhere = okPages(witness).some((p) => (p.gtm_containers_seen || []).includes(expected));
      if (seenAnywhere) return [];
      return [{
        category: 'broken_tracking',
        entity_key: expected,
        evidence: {
          metrics: { pages_checked: okPages(witness).length, pages_with_container: 0 },
          window_days: 0,
          queries: ['live/rules/container_missing@v1'],
        },
        payload: {
          locked: true,
          entities: [{ kind: 'gtm_container', value: expected }],
          fix_detail: 'Your tracking setup exists at Google but your website never loads it — nothing is being recorded at all. Reinstalling it on the site fixes everything downstream.',
        },
        icon: 'zap-off', // §9 reinstall flow, not a one-tap tool fix
      }];
    },
  },

  {
    rule_id: 'live.collect_wrong_id',
    layer: 5,
    // Data IS flowing — to the wrong place.
    run({ witness, linkedMeasurementIds }) {
      const linked = new Set(linkedMeasurementIds || []);
      if (linked.size === 0) return [];
      const wrong = new Set();
      for (const p of okPages(witness)) {
        for (const id of p.collect_measurement_ids || []) {
          if (!linked.has(id)) wrong.add(id);
        }
      }
      if (wrong.size === 0) return [];
      return [{
        category: 'broken_tracking',
        entity_key: [...wrong].sort().join(','),
        evidence: {
          metrics: { unexpected_ids: wrong.size },
          window_days: 0,
          queries: ['live/rules/collect_wrong_id@v1'],
        },
        payload: {
          locked: true,
          entities: [...wrong].map((id) => ({ kind: 'measurement_id', value: id })),
          fix_detail: 'Your site is sending visit data to a tracking setup that is not the one connected here — the numbers you look at are missing it.',
        },
        fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
        icon: 'crosshair',
      }];
    },
  },

  {
    rule_id: 'live.coverage_gap',
    layer: 5,
    // Container on the homepage, absent on key pages the crawl reached.
    run({ witness, gtm }) {
      const expected = gtm && gtm.container_public_id;
      if (!expected) return [];
      const home = okPages(witness).find((p) => p.is_homepage);
      if (!home || !(home.gtm_containers_seen || []).includes(expected)) return []; // fully-missing is container_missing's finding
      const gaps = okPages(witness).filter((p) => !p.is_homepage && !(p.gtm_containers_seen || []).includes(expected));
      if (!gaps.length) return [];
      return [{
        category: 'broken_tracking',
        entity_key: gaps.map((p) => p.url).sort().join(','),
        evidence: {
          metrics: { key_pages_checked: okPages(witness).length - 1, pages_missing: gaps.length },
          window_days: 0,
          queries: ['live/rules/coverage_gap@v1'],
        },
        payload: {
          locked: true,
          entities: gaps.map((p) => ({ kind: 'page', value: p.url })),
          fix_detail: `Tracking runs on your homepage but not on ${gaps.length} important page(s) — visits that land there are invisible. Usually one platform setting ("apply to all pages") fixes it.`,
        },
        icon: 'layout-grid', // platform-specific corrective guide, §9
      }];
    },
  },

  {
    rule_id: 'live.tag_alive',
    layer: 5,
    // The weekly heartbeat: tag verified alive before, gone now → alert path.
    run({ witness, gtm, previouslyVerified }) {
      const expected = gtm && gtm.container_public_id;
      if (!expected || !previouslyVerified || okPages(witness).length === 0) return [];
      const alive = okPages(witness).some((p) => (p.gtm_containers_seen || []).includes(expected));
      if (alive) return [];
      return [{
        category: 'broken_tracking',
        entity_key: `${expected}:heartbeat`,
        evidence: {
          metrics: { pages_checked: okPages(witness).length },
          window_days: 7,
          queries: ['live/rules/tag_alive@v1'],
        },
        payload: {
          locked: false, // breakage alerts are never paywalled
          entities: [{ kind: 'gtm_container', value: expected }],
          fix_detail: 'Your tracking was working and has now disappeared from your site — this usually happens after a site edit or theme change. One tap starts the reinstall flow.',
        },
        icon: 'heart-off', // alert email + §9 reinstall flow
      }];
    },
  },
];

module.exports = { rules };
