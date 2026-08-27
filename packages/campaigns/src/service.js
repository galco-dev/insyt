// Campaign draft service — one implementation behind both surfaces
// (agency Build door, consumer "your ad" cards). engine-spec §5 + §5.1.
//
//   createDraftService({ db, google, model, modelId })
//     .create({ tenantId, agencyId, seatId, template, inputs, sourceFinding })
//     .approve({ tenantId, draftId, actor })      → created PAUSED in Google Ads (or provisional if no creds)
//     .enable({ tenantId, draftId, actor })       → the second explicit yes
//     .edit({ tenantId, draftId, adGroups })      → edit-before-approve, diff → draft_edits (§11.3)
//     .dismiss({ tenantId, draftId })
//     .gatesFor(tenantId)                         → validateSpec health + §5.1 setup checklist
//
// google (optional): { fetchAds(tenantId), transportsFor(tenantId) }
// model  (optional): { generate({system, prompt, tenantId}) }
// Nothing here enables a campaign as a side effect of creating it.

const { buildCampaignSpec, validateSpec, sourceKeywords } = require('./builder');
const { draftCopy, validateCopy, diffCopy } = require('./copy');
const { byId: tools } = require('../../tools/src/catalogue');
const { createTelemetry } = require('../../shared/src/telemetry');

const q = (s) => encodeURIComponent(s);

function createDraftService({ db, google = null, model = null, modelId = null }) {
  const tel = createTelemetry({ db });

  async function tenantRow(tenantId) {
    return db.select('tenants', `id=eq.${q(tenantId)}&select=id,business_name,website_url&limit=1`, { single: true }).catch(() => null);
  }

  /** §5 gates + §5.1 setup checklist. Never a dead end: each blocker carries its next step. */
  async function gatesFor(tenantId) {
    const [open, journey, assets] = await Promise.all([
      db.select('findings', `tenant_id=eq.${q(tenantId)}&status=in.(open,approved,suspect)&select=rule_id,layer,severity`).catch(() => []),
      db.select('journey_state', `tenant_id=eq.${q(tenantId)}&select=journey,gates&limit=1`, { single: true }).catch(() => null),
      db.select('assets', `tenant_id=eq.${q(tenantId)}&linked=eq.true&select=kind`).catch(() => []),
    ]);
    const kinds = new Set((assets || []).map((a) => a.kind));
    const critTracking = (open || []).filter((f) => f.severity === 'critical' && [1, 2, 3, 5].includes(f.layer)).length;
    const goalBroken = (open || []).some((f) => ['ads.no_conversion_tracking', 'ads.conversion_silent', 'ga4.no_key_events'].includes(f.rule_id));
    const gates = (journey && journey.gates) || { tag: true, billing: true, approval: true };
    const health = { conversionGoalHealthy: !goalBroken, billingAttached: gates.billing !== false, openCriticalTracking: critTracking };
    // §5.1 setup checklist — what Insyt does for a first-timer, in order.
    const steps = [];
    if (!kinds.has('ga4_property')) steps.push({ key: 'ga4', label: 'Set up visit tracking', detail: 'We create it for you in one tap on Google\'s permission screen.', done: false, insyt_does_it: true });
    else steps.push({ key: 'ga4', label: 'Visit tracking', done: true });
    if (!kinds.has('gtm_container')) steps.push({ key: 'gtm', label: 'Add the tracking code to your site', detail: 'We place it for you where your website builder allows; otherwise a picture guide.', done: false, insyt_does_it: true });
    else steps.push({ key: 'gtm', label: 'Tracking code on your site', done: gates.tag !== false, detail: gates.tag === false ? 'Waiting to see it live on your site.' : undefined });
    steps.push({ key: 'goal', label: 'Counting customer actions', done: !goalBroken, detail: goalBroken ? 'Your enquiries or bookings are not being counted yet; we fix that first.' : undefined });
    if (critTracking) steps.push({ key: 'critical', label: `${critTracking} tracking issue${critTracking === 1 ? '' : 's'} to clear`, done: false, detail: 'These land in your approvals; each is one tap.' });
    steps.push({ key: 'billing', label: 'Ad money connected to Google', done: gates.billing !== false, detail: gates.billing === false ? 'One step in Google Ads; we send you the link.' : undefined });
    return { health, steps, journey: journey ? journey.journey : 'A', gates };
  }

  async function create({ tenantId, agencyId = null, seatId = null, template, inputs = {}, sourceFinding = null }) {
    const [tenant, existing, gates] = await Promise.all([
      tenantRow(tenantId),
      db.select('campaigns', `tenant_id=eq.${q(tenantId)}&select=name`).catch(() => []),
      gatesFor(tenantId),
    ]);
    let ads = null;
    if (google && google.fetchAds) { try { ads = await google.fetchAds(tenantId); } catch { ads = null; } }
    const exceptions = (await db.select('standing_exceptions', `tenant_id=eq.${q(tenantId)}&cleared_at=is.null&select=summary_text`).catch(() => [])) || [];
    const business = inputs.business || (tenant && tenant.business_name) || 'Your business';
    const cpas = ads ? (ads.campaigns || []).filter((c) => c.conversions_30d > 0).map((c) => c.spend_30d_usd / c.conversions_30d).sort((a, b) => a - b) : [];
    const median = cpas.length ? cpas[Math.floor(cpas.length / 2)] : null;
    const sourced = sourceKeywords({
      business, services: inputs.services || [], location: inputs.location || null,
      searchTerms: ads ? ads.search_terms || [] : [], accountMedianCpaUsd: median,
      exceptions: exceptions.map((e) => e.summary_text), negatives: [],
    });
    const spec = buildCampaignSpec({
      template, business, services: inputs.services || [], location: inputs.location || null,
      budget_daily_usd: inputs.budget_daily_usd, conversion_goal: inputs.conversion_goal || null,
      existing_campaign_names: (existing || []).map((c) => c.name),
      final_url: inputs.final_url || (tenant && tenant.website_url) || null,
      sourced_keywords: sourced.keywords,
    });
    // Fable copy per ad group, hard-validated, builder copy as the fallback.
    const drafted = {};
    let source = 'builder'; let modelVersion = null;
    for (const g of spec.ad_groups) {
      const r = await draftCopy({
        business, service: g.name === 'Brand' ? null : g.name, location: inputs.location || null,
        offers: inputs.offers || [], prices: inputs.prices || [], siteLines: inputs.site_lines || [],
        generate: model && model.generate ? (args) => model.generate({ ...args, tenantId }) : null, modelId, fallback: g.rsa,
      });
      g.rsa = r.rsa; drafted[g.name] = { ...r.rsa };
      if (r.source === 'model') { source = 'model'; modelVersion = r.model_version; }
    }
    spec.copy = { source, model_version: modelVersion, drafted };
    spec.keyword_sourcing = { excluded: sourced.excluded, winners: sourced.keywords.filter((k) => k.source === 'winner').length };
    const v = validateSpec(spec, gates.health);
    spec.gates = { ok: v.ok, blockers: v.blockers, steps: gates.steps };
    const [row] = await db.insert('campaign_drafts', [{
      tenant_id: tenantId, agency_id: agencyId, created_by: seatId, source_finding: sourceFinding, template: spec.template, spec,
    }]);
    await tel.event({ tenantId, agencyId, seatId, name: 'campaign.drafted', props: { template: spec.template, copy_source: source, staged: !v.ok }, source: agencyId ? 'agency' : 'server' });
    return row;
  }

  async function load(tenantId, draftId) {
    return db.select('campaign_drafts', `id=eq.${q(draftId)}&tenant_id=eq.${q(tenantId)}&select=*`, { single: true }).catch(() => null);
  }
  async function patch(draftId, fields) {
    await db.update('campaign_drafts', `id=eq.${q(draftId)}`, { ...fields, updated_at: new Date().toISOString() });
  }

  async function edit({ tenantId, draftId, adGroups = [] }) {
    const d = await load(tenantId, draftId);
    if (!d) return null;
    if (d.status !== 'draft') return { error: 'Only drafts can be edited; this one is already created.' };
    const spec = d.spec; const problems = [];
    for (const g of adGroups) {
      const target = spec.ad_groups.find((x) => x.name === g.name);
      if (!target || !g.rsa) continue;
      const v = validateCopy({ ...g.rsa, pinned: g.rsa.pinned || target.rsa.pinned }, { witnessedPrices: (spec.witnessed_prices || []) });
      if (!v.ok) { problems.push(...v.problems.map((p) => `${g.name}: ${p}`)); continue; }
      const draftedRsa = (spec.copy && spec.copy.drafted && spec.copy.drafted[g.name]) || target.rsa;
      for (const ch of diffCopy(draftedRsa, v.rsa)) {
        await tel.draftEdit({ tenantId, artifactKind: `rsa_${ch.kind}`, artifactId: `${draftId}:${g.name}:${ch.index}`, drafted: ch.drafted || '', shipped: ch.shipped || '', modelVersion: spec.copy ? spec.copy.model_version : null });
      }
      target.rsa = v.rsa;
    }
    if (problems.length) return { error: problems.join(' · ') };
    await patch(draftId, { spec });
    return { ok: true, spec };
  }

  async function approve({ tenantId, draftId, actor = 'user', agencyId = null, seatId = null }) {
    const d = await load(tenantId, draftId);
    if (!d) return null;
    if (d.status !== 'draft') return { error: `Cannot create a ${d.status} draft.` };
    const gates = await gatesFor(tenantId);
    const v = validateSpec(d.spec, gates.health);
    if (!v.ok) {
      // §5.1: never a dead end — the draft is STAGED behind the checklist.
      await patch(draftId, { spec: { ...d.spec, gates: { ok: false, blockers: v.blockers, steps: gates.steps, staged_at: new Date().toISOString() } } });
      return { status: 'staged', blockers: v.blockers, steps: gates.steps };
    }
    const guard = tools['ads.create_campaign_draft'].guard({ spec: d.spec }, {});
    if (guard) return { error: guard };
    let api = null;
    if (google && google.transportsFor) { try { api = await google.transportsFor(tenantId); } catch { api = null; } }
    if (!api || !d.spec.final_url) {
      // No credentials (or no landing page) yet: provisional, as before phase 3.
      const placeholder = `draft-${String(draftId).slice(0, 8)}`;
      await patch(draftId, { status: 'created_paused', google_campaign_id: placeholder });
      await db.insert('campaigns', [{ tenant_id: tenantId, google_campaign_id: placeholder, name: d.spec.name, status: 'paused', channel: d.spec.channel, budget_daily_usd: d.spec.budget_daily_usd, bidding: d.spec.bidding }], { returning: false }).catch(() => {});
      return { status: 'created_paused', provisional: true, reason: api ? 'no landing page on file' : 'Google credentials not configured' };
    }
    const result = await api['ads.create_campaign_draft']({ spec: d.spec, final_url: d.spec.final_url });
    const after = result.after;
    await patch(draftId, { status: 'created_paused', google_campaign_id: after.campaign_id, spec: { ...d.spec, created: after } });
    await db.upsert('campaigns', [{ tenant_id: tenantId, google_campaign_id: after.campaign_id, name: d.spec.name, status: 'paused', channel: d.spec.channel, budget_daily_usd: d.spec.budget_daily_usd, bidding: d.spec.bidding, last_seen_at: new Date().toISOString() }], 'tenant_id,google_campaign_id').catch(() => {});
    await db.insert('changes', [{ tenant_id: tenantId, finding_id: d.source_finding || null, tool_id: 'ads.create_campaign_draft', params: { draft_id: draftId }, status: 'applied', applied_at: new Date().toISOString(), actor, summary_text: `Created "${d.spec.name}" in Google Ads, paused`, before: { line: 'No campaign' }, after: { line: `"${d.spec.name}" exists, paused, spending nothing` }, idempotency_key: `create:${draftId}` }], { returning: false }).catch(() => {});
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'fix_applied', actor, summary_text: `Created "${d.spec.name}" in Google Ads. It is paused and spends nothing until you switch it on.` }], { returning: false }).catch(() => {});
    await tel.event({ tenantId, agencyId, seatId, name: 'campaign.created_paused', props: { draft_id: draftId, warnings: (after.warnings || []).length }, source: agencyId ? 'agency' : 'server' });
    return { status: 'created_paused', campaign_id: after.campaign_id, warnings: after.warnings || [] };
  }

  async function enable({ tenantId, draftId, actor = 'user', agencyId = null, seatId = null }) {
    const d = await load(tenantId, draftId);
    if (!d) return null;
    if (d.status !== 'created_paused') return { error: `Cannot enable a ${d.status} draft.` };
    const gates = await gatesFor(tenantId);
    const g = gates.gates || {};
    if (!(g.tag !== false && g.billing !== false)) return { error: 'Tracking and billing must both be in place before this switches on.', steps: gates.steps };
    if (String(d.google_campaign_id || '').startsWith('draft-')) {
      await patch(draftId, { status: 'enabled' });
      return { status: 'enabled', provisional: true };
    }
    // The second explicit yes: its own approval record, its own tool call.
    await db.insert('approvals', [{ tenant_id: tenantId, scope: 'campaign_launch', target_id: draftId, channel: agencyId ? 'dashboard' : 'dashboard' }], { returning: false }).catch(() => {});
    const guard = tools['ads.unpause_launch'].guard({ campaign_id: d.google_campaign_id }, { approvals: [{ scope: 'campaign_launch', target_id: d.google_campaign_id }], gates: { tag: true, billing: true, approval: true } });
    if (guard) return { error: guard };
    let api = null;
    if (google && google.transportsFor) { try { api = await google.transportsFor(tenantId); } catch { api = null; } }
    if (!api) return { error: 'Google credentials not configured; cannot enable yet.' };
    await api['ads.unpause_launch']({ campaign_id: d.google_campaign_id });
    await patch(draftId, { status: 'enabled' });
    await db.update('campaigns', `tenant_id=eq.${q(tenantId)}&google_campaign_id=eq.${q(d.google_campaign_id)}`, { status: 'enabled' }).catch(() => {});
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'campaign_launched', actor, summary_text: `"${d.spec.name}" is live. Up to $${d.spec.budget_daily_usd} a day; one tap pauses it any time.` }], { returning: false }).catch(() => {});
    await tel.event({ tenantId, agencyId, seatId, name: 'campaign.enabled', props: { draft_id: draftId }, source: agencyId ? 'agency' : 'server' });
    return { status: 'enabled' };
  }

  async function dismiss({ tenantId, draftId }) {
    const d = await load(tenantId, draftId);
    if (!d) return null;
    if (!['draft', 'approved', 'created_paused'].includes(d.status)) return { error: `Cannot dismiss a ${d.status} draft.` };
    await patch(draftId, { status: 'dismissed' });
    return { status: 'dismissed' };
  }

  return { create, approve, enable, edit, dismiss, gatesFor };
}

module.exports = { createDraftService };
