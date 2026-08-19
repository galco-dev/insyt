// Watch handlers — build-doc §9/§15. Pure logic over injected I/O:
//   deps: { db, crawler: { verificationCrawl(url) }, now() }
// Each handler returns { triggered?, resolved?, patch? } for the pump.

function makeHandlers({ db, crawler, now = Date.now }) {
  const q = (s) => encodeURIComponent(s);

  async function tenantSite(tenantId) {
    const t = await db.select('tenants', `id=eq.${q(tenantId)}&select=website_url&limit=1`, { single: true });
    return t && t.website_url;
  }

  async function expectedContainer(tenantId) {
    const a = await db.select('assets', `tenant_id=eq.${q(tenantId)}&kind=eq.gtm_container&linked=eq.true&select=external_id&limit=1`, { single: true });
    return a && a.external_id;
  }

  return {
    // Lifetime weekly heartbeat (§9): tag verified before, still there now?
    tag_alive: async (watch) => {
      const [url, container] = await Promise.all([tenantSite(watch.tenant_id), expectedContainer(watch.tenant_id)]);
      if (!url || !container) return { patch: {} }; // nothing to check yet
      const witness = await crawler.verificationCrawl(url);
      const alive = (witness.pages || []).some((p) => p.ok && (p.gtm_containers_seen || []).includes(container));
      if (alive) return { patch: { baseline: { last_alive_at: new Date(now()).toISOString() } } };
      // Disappeared: alert email + ledger; watch stays triggered until reinstall.
      await db.insert('emails', [{
        tenant_id: watch.tenant_id, template_id: 'tracking_disappeared',
        to_email: await ownerEmail(db, watch.tenant_id), stream: 'transactional', status: 'queued',
        payload: { guide_url: `${process.env.APP_BASE_URL || 'https://app.tryinsyt.com'}/app/journey` },
      }], { returning: false }).catch(() => {});
      await db.insert('ledger', [{
        tenant_id: watch.tenant_id, event: 'watch_triggered', actor: 'system',
        summary_text: 'Your tracking disappeared from your site — we emailed you a one-tap reinstall.',
      }], { returning: false }).catch(() => {});
      return { triggered: true };
    },

    // 48h post-changeset watch (§4, master §3.7): the crash path is driven by
    // triggered runs (fire.volume_anomaly); a watch that reaches its window
    // without a crash flag resolves as verified.
    changeset_verify: async (watch) => {
      const until = watch.schedule && watch.schedule.until ? Date.parse(watch.schedule.until) : null;
      if (!until) return { resolved: true }; // malformed — close it rather than spin
      if (now() < until) return { patch: {} }; // keep watching
      await db.update('changesets', `id=eq.${q(watch.target_id)}`, { status: 'verified' }).catch(() => {});
      await db.insert('emails', [{
        tenant_id: watch.tenant_id, template_id: 'fix_verified_48h',
        to_email: await ownerEmail(db, watch.tenant_id), stream: 'transactional', status: 'queued',
        payload: { fix_summary: (watch.baseline && watch.baseline.fix_summary) || 'your approved fixes', verify_detail: 'numbers held steady for 48 hours' },
      }], { returning: false }).catch(() => {});
      await db.insert('ledger', [{
        tenant_id: watch.tenant_id, event: 'tag_verified', actor: 'system',
        summary_text: 'Verified: 48 hours after your fixes, everything looks right.',
      }], { returning: false }).catch(() => {});
      return { resolved: true };
    },
  };
}

async function ownerEmail(db, tenantId) {
  const q = (s) => encodeURIComponent(s);
  const u = await db.select('users', `tenant_id=eq.${q(tenantId)}&select=email&limit=1`, { single: true });
  return (u && u.email) || '';
}

/**
 * Journey tag-install pump (§9) — separate from watches: drains journey_state
 * rows whose tag_install.next_poll_at is due, advances the state machine, and
 * applies its effects (emails, gates, watch creation).
 */
async function pumpTagInstalls({ db, crawler, advance, now = Date.now, limit = 20 }) {
  const q = (s) => encodeURIComponent(s);
  const nowIso = new Date(now()).toISOString();
  const due = await db.select('journey_state',
    `select=*&tag_install->>verified_at=is.null&or=(tag_install->>next_poll_at.is.null,tag_install->>next_poll_at.lt.${q(nowIso)})&limit=${limit}`);
  const actions = { polled: 0, verified: 0 };

  for (const row of due) {
    const state = row.tag_install || {};
    if (!state.guide_issued_at) continue; // guide not issued yet — nothing to poll
    const [site, container] = await Promise.all([
      db.select('tenants', `id=eq.${q(row.tenant_id)}&select=website_url`, { single: true }),
      db.select('assets', `tenant_id=eq.${q(row.tenant_id)}&kind=eq.gtm_container&select=external_id&limit=1`, { single: true }),
    ]);
    if (!site || !site.website_url || !container) continue;

    let pollResult = { container_seen: false };
    try {
      const witness = await crawler.verificationCrawl(site.website_url);
      const pages = witness.pages || [];
      const seen = pages.some((p) => p.ok && (p.gtm_containers_seen || []).includes(container.external_id));
      const collect = pages.some((p) => p.ok && (p.collect_measurement_ids || []).length > 0);
      const coverage = pages.filter((p) => p.ok).every((p) => (p.gtm_containers_seen || []).includes(container.external_id));
      pollResult = { container_seen: seen, collect_fired_correct_id: collect, coverage_ok: coverage, ga4_data_arrived: collect };
    } catch { /* site unreachable — treated as not seen; backoff continues */ }

    const { state: next, effects } = advance(state, pollResult, now());
    actions.polled += 1;
    for (const e of effects) {
      if (e.type === 'email') {
        await db.insert('emails', [{
          tenant_id: row.tenant_id, template_id: e.template_id,
          to_email: await ownerEmail(db, row.tenant_id), stream: 'transactional', status: 'queued',
          payload: { guide_url: `${process.env.APP_BASE_URL || 'https://app.tryinsyt.com'}/app/journey` },
        }], { returning: false }).catch(() => {});
      }
      if (e.type === 'gate') {
        await db.update('journey_state', `id=eq.${q(row.id)}`, { gates: { ...row.gates, [e.gate]: e.value } }).catch(() => {});
      }
      if (e.type === 'watch') {
        await db.insert('watches', [{ tenant_id: row.tenant_id, kind: e.kind, status: 'active' }], { returning: false }).catch(() => {});
        actions.verified += 1;
      }
    }
    await db.update('journey_state', `id=eq.${q(row.id)}`, { tag_install: next, updated_at: nowIso }).catch(() => {});
  }
  return actions;
}

module.exports = { makeHandlers, pumpTagInstalls, ownerEmail };
