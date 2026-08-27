// Layer 1 — GTM config rules (build-doc §3).
// Input: a normalised GTM container snapshot (fetched once per run, cached
// 24h per the §8 quota budget) plus tenant context. Shape:
//
// ctx.gtm = {
//   container_public_id: 'GTM-XXXX',
//   tags: [{ id, name, type,            // 'gaawc' (GA4 config), 'gaawe' (GA4 event),
//                                       // 'ua', 'awct' (AW conversion), 'html', ...
//            paused, measurement_id,    // for GA4/UA tags
//            trigger_ids: [],
//            consent_settings }],       // per-tag consent status if present
//   triggers: [{ id, name, type }],
//   workspace_changes: [{ change_type, entity, changed_at }],
//   versions: { latest: { version_id, created_at, tags: [...] },
//               previous: { version_id, tags: [...] } | null },
// }
// ctx.linkedMeasurementIds: G-IDs of GA4 streams on the tenant's linked property
// ctx.servesEuUk: crawl/geo signal for consent-mode applicability
// ctx.eventVolumeDrops: [{ event_name, drop_pct, breakpoint_date }] — Layer 3 join
// ctx.now: ms epoch (injected — engine code never calls Date.now())
//
// Every rule returns partial findings: { category, entity_key, evidence,
// payload, fix?, money?, severity_override? }. Severity itself comes from
// rule_config (05 seed migration) — overrides only where §3 says "by magnitude".

const GA4_CONFIG_TYPES = new Set(['gaawc', 'googtag']); // GA4 config / Google tag
const LEGACY_TYPES = new Set(['ua', 'ua_event', 'awct_legacy', 'flc', 'fls']); // UA + old pixels

const active = (t) => !t.paused;

const rules = [
  {
    rule_id: 'gtm.duplicate_ga4_tags',
    layer: 1,
    // Two+ GA4 config tags, same measurement ID, overlapping trigger → double count.
    run({ gtm }) {
      const byId = new Map();
      for (const t of gtm.tags.filter((t) => GA4_CONFIG_TYPES.has(t.type) && active(t) && t.measurement_id)) {
        if (!byId.has(t.measurement_id)) byId.set(t.measurement_id, []);
        byId.get(t.measurement_id).push(t);
      }
      const out = [];
      for (const [mid, tags] of byId) {
        if (tags.length < 2) continue;
        const triggerOverlap = tags.some((a, i) => tags.slice(i + 1).some(
          (b) => a.trigger_ids.some((tr) => b.trigger_ids.includes(tr)),
        ));
        if (!triggerOverlap) continue;
        out.push({
          category: 'double_counting',
          entity_key: mid,
          evidence: {
            metrics: { duplicate_tag_count: tags.length },
            window_days: 0,
            queries: ['gtm/rules/duplicate_ga4_tags@v1'],
          },
          payload: {
            locked: true,
            entities: tags.map((t) => ({ kind: 'gtm_tag', value: t.name, tag_id: t.id })),
            fix_detail: `Pause ${tags.length - 1} duplicate tag(s); keep "${tags[0].name}".`,
          },
          fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
          icon: 'copy',
        });
      }
      return out;
    },
  },

  {
    rule_id: 'gtm.orphan_tags',
    layer: 1,
    // Tags with no trigger, or referencing triggers that no longer exist.
    run({ gtm }) {
      const triggerIds = new Set(gtm.triggers.map((t) => String(t.id)));
      return gtm.tags.filter(active).flatMap((t) => {
        const refs = t.trigger_ids || [];
        const dead = refs.filter((id) => !triggerIds.has(String(id)));
        const orphaned = refs.length === 0 || dead.length === refs.length;
        if (!orphaned) return [];
        return [{
          category: 'config_debris',
          entity_key: String(t.id),
          evidence: { metrics: { dead_trigger_refs: dead.length }, window_days: 0, queries: ['gtm/rules/orphan_tags@v1'] },
          payload: {
            locked: true,
            entities: [{ kind: 'gtm_tag', value: t.name, tag_id: t.id }],
            fix_detail: refs.length === 0 ? 'Tag has no trigger — it can never fire.' : 'All trigger references point to deleted triggers.',
          },
          // §3: remove_tag is brief-only default — no fix proposed automatically.
          icon: 'unlink',
        }];
      });
    },
  },

  {
    rule_id: 'gtm.id_mismatch',
    layer: 1,
    // GA4 tag measurement ID ≠ any stream on the linked property.
    run({ gtm, linkedMeasurementIds }) {
      const linked = new Set(linkedMeasurementIds || []);
      if (linked.size === 0) return []; // nothing linked yet — Layer 2 covers that
      return gtm.tags
        // Only GA4 ids (G-…) can mismatch a GA4 stream. AW-/DC-/GT- Google tags
        // are Ads/Floodlight/gateway tags and legitimately carry other ids.
        .filter((t) => GA4_CONFIG_TYPES.has(t.type) && active(t) && /^G-/i.test(t.measurement_id || '') && !linked.has(t.measurement_id))
        .map((t) => ({
          category: 'broken_tracking',
          entity_key: `${t.id}:${t.measurement_id}`,
          evidence: {
            metrics: { linked_stream_count: linked.size },
            window_days: 0,
            queries: ['gtm/rules/id_mismatch@v1'],
          },
          payload: {
            locked: true,
            entities: [{ kind: 'gtm_tag', value: t.name, tag_id: t.id, sends_to: t.measurement_id }],
            fix_detail: `Point "${t.name}" at the measurement ID of your linked tracking instead of ${t.measurement_id}.`,
          },
          fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'change' },
          icon: 'crosshair',
        }));
    },
  },

  {
    rule_id: 'gtm.legacy_debris',
    layer: 1,
    // UA tags and old conversion pixels still present and active.
    run({ gtm }) {
      const legacy = gtm.tags.filter((t) => (LEGACY_TYPES.has(t.type) || /^UA-/.test(t.measurement_id || '')) && active(t));
      if (legacy.length === 0) return [];
      return [{
        category: 'config_debris',
        entity_key: 'legacy',
        evidence: { metrics: { legacy_tag_count: legacy.length }, window_days: 0, queries: ['gtm/rules/legacy_debris@v1'] },
        payload: {
          locked: true,
          entities: legacy.map((t) => ({ kind: 'gtm_tag', value: t.name, tag_id: t.id, tag_type: t.type })),
          fix_detail: `Pause ${legacy.length} outdated tag(s) — they stopped collecting data in 2023 but still slow your pages.`,
        },
        fix: { params_ref: 'changes.params', risk: 'low', reversible: true, approval_scope: 'change' },
        icon: 'archive',
      }];
    },
  },

  {
    rule_id: 'gtm.consent_mode_absent',
    layer: 1,
    // No consent mode where the site serves EU/UK traffic. Brief-only.
    run({ gtm, servesEuUk }) {
      if (!servesEuUk) return [];
      const hasConsent = gtm.tags.some((t) => t.consent_settings && t.consent_settings.status === 'set')
        || gtm.tags.some((t) => t.type === 'cnsnt' || /consent/i.test(t.type));
      if (hasConsent) return [];
      return [{
        category: 'compliance',
        entity_key: gtm.container_public_id,
        evidence: { metrics: {}, window_days: 0, queries: ['gtm/rules/consent_mode_absent@v1'] },
        payload: {
          locked: true,
          entities: [],
          fix_detail: 'Your site serves European visitors but tracking has no consent handling — ad data from those visitors is at risk.',
        },
        icon: 'shield-alert',
      }];
    },
  },

  {
    rule_id: 'gtm.unpublished_changes',
    layer: 1,
    // Workspace changes sitting unpublished beyond threshold (default 7 days).
    run({ gtm, now, thresholds }) {
      const days = thresholds.stale_days ?? 7;
      const changes = gtm.workspace_changes || [];
      if (changes.length === 0) return [];
      const oldest = Math.min(...changes.map((c) => Date.parse(c.changed_at)));
      const ageDays = (now - oldest) / 86_400_000;
      if (ageDays <= days) return [];
      return [{
        category: 'config_hygiene',
        entity_key: gtm.container_public_id,
        evidence: {
          metrics: { pending_changes: changes.length, oldest_change_age_days: Math.floor(ageDays) },
          window_days: days,
          queries: ['gtm/rules/unpublished_changes@v1'],
        },
        payload: {
          locked: true,
          entities: changes.map((c) => ({ kind: 'workspace_change', value: `${c.change_type} ${c.entity}` })),
          fix_detail: `${changes.length} saved change(s) were never made live — the site still runs the old setup.`,
        },
        // gtm.publish is its own approval scope (§4) — full version diff shown.
        fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'changeset' },
        icon: 'upload',
      }];
    },
  },

  {
    rule_id: 'gtm.version_regression',
    layer: 1,
    // Latest-vs-previous version diff: deleted/paused tags correlated with
    // event volume drops (the Layer 3 join arrives via ctx.eventVolumeDrops).
    run({ gtm, eventVolumeDrops }) {
      const { latest, previous } = gtm.versions || {};
      if (!latest || !previous || !(eventVolumeDrops || []).length) return [];
      const latestById = new Map(latest.tags.map((t) => [String(t.id), t]));
      const regressed = previous.tags.filter((t) => {
        const nowTag = latestById.get(String(t.id));
        return !nowTag || (nowTag.paused && !t.paused);
      });
      if (regressed.length === 0) return [];
      const dropsByEvent = new Map(eventVolumeDrops.map((d) => [d.event_name, d]));
      const correlated = regressed.filter((t) => t.event_name && dropsByEvent.has(t.event_name));
      if (correlated.length === 0) return [];
      return [{
        category: 'broken_tracking',
        entity_key: `v${previous.version_id}->v${latest.version_id}`,
        evidence: {
          metrics: {
            removed_or_paused: regressed.length,
            correlated_drops: correlated.length,
            max_drop_pct: Math.max(...correlated.map((t) => dropsByEvent.get(t.event_name).drop_pct)),
          },
          window_days: 28,
          queries: ['gtm/rules/version_regression@v1'],
        },
        payload: {
          locked: true,
          entities: correlated.map((t) => ({
            kind: 'gtm_tag', value: t.name, tag_id: t.id,
            event: t.event_name, drop_pct: dropsByEvent.get(t.event_name).drop_pct,
          })),
          fix_detail: `Restore ${correlated.length} tag(s) from the previous version — their events stopped arriving right after the change.`,
        },
        fix: { params_ref: 'changes.params', risk: 'medium', reversible: true, approval_scope: 'changeset' },
        icon: 'history',
      }];
    },
  },
];

module.exports = { rules, GA4_CONFIG_TYPES, LEGACY_TYPES };
