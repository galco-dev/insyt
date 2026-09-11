// The §8 stage list, wiring the existing packages. Each stage's external
// I/O goes through injected clients so the pipeline tests offline and the
// Railway service supplies real ones.
//
// buildStages({ google, crawler, model, store }) -> ordered stage array
//   google:  { fetchGtmSnapshot(tenant), fetchGa4Config(tenant),
//              fetchGa4Data(tenant), fetchAds(tenant), fetchAdsDeep?(tenant) }
//            fetchAdsDeep is optional: when present its blocks ride on
//            ads.deep (measured); when absent or failing, the deep rules see
//            no block and the report lists the dataset as not yet examined.
//   crawler: { verificationCrawl(url) }
//   model:   { generate({system, prompt}) }                (Anthropic client)
//   store:   { ruleConfig(), priorFindings(tenantId), ledgerCumulative(tenantId),
//              saveFindings(runId, findings), saveReport(runId, {html_email, html_web, findings}),
//              saveSnapshots?(tenantId, ads) — campaigns + spend_daily + asset labels,
//              draftState?(tenantId) + saveDrafts?(runId, tenantId, drafts, skipped)   — §6.1 draft_pass
//              dueChangeWatches?(tenantId) + closeChangeWatch?({...})                  — §6.1 watch_close
//              openFindings?(tenantId) + applyDiff?(tenantId, runId, {supersede, resolved}) + hasPriorRun?  — §6.1 diff_pass }
//   google.fetchWindow?(tenantId, { since, campaignIds, terms })  — watch measurement (§4.4)

const { runRules, healthScore } = require('../../../packages/rules/src/engine');
const l1 = require('../../../packages/rules/src/layer1-gtm');
const l2 = require('../../../packages/rules/src/layer2-ga4');
const l3 = require('../../../packages/rules/src/layer3-fire');
const l4 = require('../../../packages/rules/src/layer4-ads');
const l5 = require('../../../packages/rules/src/layer5-live');
const l4rsa = require('../../../packages/rules/src/layer4-rsa');
const l5urls = require('../../../packages/rules/src/layer5-urls');
const { computeVolumeDrops } = require('../../../packages/rules/src/layer3-fire');
const { assembleEnvelope } = require('../../../packages/report/src/envelope');
const { assembleDeep } = require('../../../packages/report/src/deep');
const l6 = require('../../../packages/rules/src/layer6-deep');
const lj = require('../../../packages/rules/src/journey');
const { narrateFinding, narrateSlots } = require('../../../packages/report/src/narration');
const { draftChanges } = require('../../../packages/registry/src/drafts');
const { diffFindings, sinceLastWeekLine } = require('../../../packages/rules/src/diff');
const { judgeWatch } = require('../../../packages/registry/src/watches');
const { byTool: registryByTool } = require('../../../packages/registry/src/registry');
const crypto = require('node:crypto');
const { renderReport } = require('../../../packages/report/src/render');

const ALL_RULES = [...l1.rules, ...l2.rules, ...l3.rules, ...l4.rules, ...l4rsa.rules, ...l5.rules, ...l5urls.rules, ...l6.rules, ...lj.rules];

function buildStages({ google, crawler, model, store }) {
  return [
    {
      name: 'fetch_gtm',
      run: async (ctx) => ({ gtm: await google.fetchGtmSnapshot(ctx.run.tenant_id) }),
    },
    {
      name: 'fetch_ga4_config',
      run: async (ctx) => ({ ga4: await google.fetchGa4Config(ctx.run.tenant_id) }),
    },
    {
      name: 'fetch_ga4_data',
      run: async (ctx) => {
        const ga4Data = await google.fetchGa4Data(ctx.run.tenant_id);
        return { ga4Data, _progress: { events_reviewed: (ga4Data.events || []).length } };
      },
    },
    {
      name: 'fetch_ads',
      run: async (ctx) => {
        const ads = await google.fetchAds(ctx.run.tenant_id);
        const progress = { search_terms_reviewed: (ads.search_terms || []).length };
        if (google.fetchAdsDeep && !ads.deep) {
          // Deep blocks are additive: a failure here degrades to "not yet
          // examined" for those datasets and never fails the stage.
          try {
            ads.deep = await google.fetchAdsDeep(ctx.run.tenant_id);
            if (!ads.currency && ads.deep.currency_code) ads.currency = ads.deep.currency_code;
            progress.deep_blocks_measured = Object.values(ads.deep.blocks || {}).filter((b) => b.status === 'measured').length;
          } catch (e) {
            progress.deep_unavailable = String(e && e.message || e).slice(0, 200);
          }
        }
        return { ads, _progress: progress };
      },
    },
    {
      name: 'snapshot', // campaigns + spend_daily + asset labels; feeds pacing, the spend card, and §11 telemetry
      run: async (ctx) => {
        if (!ctx.ads || !store.saveSnapshots) return {};
        const r = await store.saveSnapshots(ctx.run.tenant_id, ctx.ads, ctx.run.id);
        return { _progress: r || {} };
      },
    },
    {
      name: 'live_witness', // failure never blocks config layers — not required
      run: async (ctx) => ({ witness: await crawler.verificationCrawl(ctx.run.website_url) }),
    },
    {
      name: 'rules_pass',
      required: true,
      run: async (ctx) => {
        const now = Date.now();
        const eventVolumeDrops = ctx.ga4Data ? computeVolumeDrops(ctx.ga4Data, {}, now) : [];
        const silentGa4Events = (ctx.ga4Data && ctx.gtm)
          ? l3.expectedEvents(ctx.gtm).filter((e) => !(ctx.ga4Data.events || []).some((ev) => ev.event_name === e && ev.total_30d > 0))
          : [];
        const { findings, errors, counts } = runRules({
          rules: ALL_RULES.filter((r) => stageDataPresent(r, ctx)),
          ruleConfig: await store.ruleConfig(),
          ctx: {
            gtm: ctx.gtm, ga4: ctx.ga4, ga4Data: ctx.ga4Data, ads: ctx.ads, witness: ctx.witness,
            adsDeep: ctx.adsDeep || (ctx.ads && ctx.ads.deep) || null,
            linkedMeasurementIds: ctx.ga4 ? [ctx.ga4.measurement_ids || []].flat() : [],
            linkedAdsCustomerIds: ctx.ads ? [ctx.ads.customer_id] : [],
            servesEuUk: !!ctx.run.serves_eu_uk,
            eventVolumeDrops, silentGa4Events,
            gtmPublishDates: (ctx.gtm && ctx.gtm.publish_dates) || [],
            previouslyVerified: !!ctx.run.tag_previously_verified,
            // §5.1 setup checklist input (journey + linked assets), when the store provides it
            setup: store.setupState ? await store.setupState(ctx.run.tenant_id).catch(() => null) : null,
            now,
          },
          priorFindings: await store.priorFindings(ctx.run.tenant_id),
          runId: ctx.run.id,
          tenantId: ctx.run.tenant_id,
        });
        // Stable ids now, so drafted changes (draft_pass) can reference their
        // finding before anything is persisted.
        for (const f of findings) if (!f.finding_id) f.finding_id = crypto.randomUUID();
        return { findings, ruleErrors: errors, counts, _progress: { findings: findings.length } };
      },
    },
    {
      // §6.1 diff_pass: dedupe vs open findings (first_seen carried), close
      // the ones that no longer fire ("fixed itself / you fixed it — we
      // noticed"), and compute the deterministic since-last-week numbers.
      name: 'diff_pass',
      run: async (ctx) => {
        const prior = store.openFindings ? await store.openFindings(ctx.run.tenant_id) : [];
        const firstRun = !prior.length && !(store.hasPriorRun ? await store.hasPriorRun(ctx.run.tenant_id, ctx.run.id) : false);
        const d = diffFindings({ findings: ctx.findings || [], prior, now: Date.now() });
        if (store.applyDiff) await store.applyDiff(ctx.run.tenant_id, ctx.run.id, { supersede: d.supersede, resolved: d.resolved });
        return {
          findings: d.findings,
          diff: { ...d.summary, first_run: firstRun, line: sinceLastWeekLine(d.summary, firstRun) },
          _progress: { new: d.summary.new, still_open: d.summary.still_open, resolved: d.summary.resolved },
        };
      },
    },
    {
      // §6.1 watch_close: close due per-change watches with a measured window,
      // write outcome + effect sizes, and turn regressions into
      // watch.change_regressed findings that propose the rollback (ask-first;
      // tracking breakage auto-reverts, §9.3).
      name: 'watch_close',
      run: async (ctx) => {
        if (!store.dueChangeWatches || !store.closeChangeWatch) return {};
        const due = await store.dueChangeWatches(ctx.run.tenant_id);
        if (!due.length) return {};
        const extra = [];
        let closed = 0;
        for (const { watch, change } of due) {
          const kind = (watch.schedule && watch.schedule.kind) || 'generic';
          let window = null;
          if (google.fetchWindow && change) {
            try {
              window = await google.fetchWindow(ctx.run.tenant_id, {
                since: watch.baseline && watch.baseline.applied_at ? watch.baseline.applied_at : watch.created_at,
                campaignIds: change.params && change.params.campaign_id ? [change.params.campaign_id] : [],
                terms: change.params && Array.isArray(change.params.terms) ? change.params.terms.map((t) => t.text) : [],
              });
            } catch { window = null; }
          }
          const verdict = judgeWatch({ kind, baseline: watch.baseline || {}, window });
          const row = change ? registryByTool(change.tool_id) : null;
          const rollback = row && row.rollback && change ? row.rollback(change) : null;
          await store.closeChangeWatch({ watch, change, verdict, rollback, tenantId: ctx.run.tenant_id, runId: ctx.run.id });
          closed += 1;
          if (verdict.outcome === 'regressed' && rollback && !verdict.tracking_breakage) {
            extra.push({
              schema_version: 1, run_id: ctx.run.id, tenant_id: ctx.run.tenant_id, finding_id: crypto.randomUUID(),
              rule_id: 'watch.change_regressed', layer: 6, severity: 'warning', status: 'open', category: 'verification',
              entity_key: `change:${change.id}`, first_seen_run_id: ctx.run.id, title: null, explanation: null,
              money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
              evidence: { metrics: verdict.effect, window_days: window ? window.days : 0, queries: ['watch/change_regressed@v1'] },
              payload: {
                locked: false, entities: [], fix_detail: verdict.line,
                change_id: change.id, rollback: { ...rollback, target: change.target },
                before_line: `We changed: ${change.summary_text || change.tool_id}. ${verdict.line}`,
                after_line: 'The change is undone and the account returns to how it was before it',
                summary: `Undid: ${change.summary_text || change.tool_id}`,
              },
              fix: { available: true, tool_id: rollback.tool_id, risk: 'low', reversible: true, approval_scope: 'change' },
              display: { icon: 'undo', badge_color: 'warning', sort_weight: 60 },
            });
          }
        }
        return { findings: [...(ctx.findings || []), ...extra], _progress: { watches_closed: closed, regressions: extra.length } };
      },
    },
    {
      name: 'money_math',
      required: true,
      // Money is computed inside the rules; this stage totals + health score.
      run: async (ctx) => ({ health_score: healthScore(ctx.findings) }),
    },
    {
      name: 'narration',
      timeoutMs: 8 * 60_000, // many findings × grounded retries; calls run 4-wide below
      run: async (ctx) => {
        // Tenant + run ride along so the model client can meter usage per
        // tenant (§9.9) and stamp attribution (§1).
        const generate = (args) => model.generate({ ...args, tenantId: ctx.run.tenant_id, runId: ctx.run.id });
        const narrateOne = async (f) => {
          try {
            const { title, explanation } = await narrateFinding(f, generate);
            return { ...f, title, explanation };
          } catch {
            // Grounding failed twice — fall back to the payload-free fix_detail-less engine framing.
            return { ...f, title: f.rule_id.replace(/[._]/g, ' '), explanation: '' };
          }
        };
        // Small worker pool: order preserved, four model calls in flight.
        const findings = new Array(ctx.findings.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, ctx.findings.length) }, async () => {
          while (next < ctx.findings.length) { const i = next++; findings[i] = await narrateOne(ctx.findings[i]); }
        }));
        const diffLine = ctx.diff ? ctx.diff.line : '';
        const slots = await narrateSlots({ counts: ctx.counts, totals: { waste: null }, previousWeek: ctx.diff && !ctx.diff.first_run ? { new: ctx.diff.new, still_open: ctx.diff.still_open, resolved: ctx.diff.resolved } : null }, generate)
          .catch(() => ({ exec_summary: '', since_last_week: diffLine }));
        // The since-last-week numbers are engine-computed; the model only restyles.
        if (!slots.since_last_week) slots.since_last_week = diffLine;
        return { findings, narrativeSlots: slots };
      },
    },
    {
      name: 'render',
      required: true,
      run: async (ctx) => {
        const deep = assembleDeep({
          adsDeep: ctx.adsDeep || (ctx.ads && ctx.ads.deep) || null,
          witness: ctx.witness,
          findings: ctx.findings,
          changes: store.changeRegister ? await store.changeRegister(ctx.run.tenant_id).catch(() => []) : [],
          extraUnexamined: ['demographics', 'conversion_lag', 'change_history', 'seasonality'],
        });
        const code = (ctx.ads && ctx.ads.currency_code) || 'USD';
        // Money figures are in the account's own currency - stamp every finding.
        for (const f of ctx.findings) if (f.money) f.money.currency = code;
        const envelope = assembleEnvelope({
          run: { id: ctx.run.id, type: ctx.run.type, status: 'complete' },
          findings: ctx.findings,
          currencyCode: code,
          ledgerCumulative: await store.ledgerCumulative(ctx.run.tenant_id),
          narrativeSlots: ctx.narrativeSlots,
          deep,
          // "Against your goals" section — present only when the (agency)
          // account has targets set; store.performanceFor is optional.
          performance: store.performanceFor
            ? await store.performanceFor(ctx.run.tenant_id).catch(() => null)
            : null,
        });
        return {
          envelope,
          html_email: renderReport(envelope, { unlocked: false, healthScore: ctx.health_score, mode: 'email' }),
          html_web: renderReport(envelope, { unlocked: false, healthScore: ctx.health_score, mode: 'web' }),
        };
      },
    },
    {
      name: 'deliver',
      required: true,
      run: async (ctx) => {
        await store.saveFindings(ctx.run.id, ctx.findings);
        // §6.1 draft_pass: registry turns findings into drafted changes;
        // autopilot-eligible ones within bounds go straight to the apply
        // loop (ledger actor autopilot), the rest become cards.
        let drafted = null;
        if (store.draftState && store.saveDrafts) {
          const state = await store.draftState(ctx.run.tenant_id);
          // Fresh run data beats the snapshot for the bounds: live budgets,
          // live daily total, and the converting-term guard (§4.2).
          if (ctx.ads) {
            const camps = ctx.ads.campaigns || [];
            state.bounds.campaign = (id) => camps.find((c) => String(c.id) === String(id)) || null;
            state.bounds.account = { daily_budget_total_usd: camps.filter((c) => c.status === 'enabled').reduce((s, c) => s + (c.budget_daily_usd || 0), 0) || state.bounds.account.daily_budget_total_usd };
            state.bounds.converting_terms = new Set((ctx.ads.search_terms || []).filter((t) => (t.conversions_90d || 0) > 0).map((t) => t.term));
          }
          const { drafts, skipped } = draftChanges({
            findings: ctx.findings,
            ctx: { ads: ctx.ads, adsDeep: ctx.adsDeep || (ctx.ads && ctx.ads.deep) || null, ga4: ctx.ga4, gtm: ctx.gtm, witness: ctx.witness },
            state: state.bounds, autopilot: state.autopilot,
            exceptions: state.exceptions, fences: state.fences || new Set(), inflight: state.inflight, recent: state.recent,
          });
          drafted = await store.saveDrafts(ctx.run.id, ctx.run.tenant_id, drafts, skipped);
        }
        const type = ctx.run.type === 'signup_audit' ? 'signup' : ctx.run.type === 'deep' ? 'deep' : 'weekly';
        const summary = ctx.envelope ? {
          currency: ctx.envelope.currency_code || 'USD',
          health_score: ctx.health_score ?? null,
          waste_monthly_usd: ctx.envelope.totals ? ctx.envelope.totals.waste_monthly_usd : null,
          counts: ctx.envelope.counts || null,
          exec_summary: ctx.envelope.narrative_slots ? ctx.envelope.narrative_slots.exec_summary : '',
          since_last_week: ctx.envelope.narrative_slots ? ctx.envelope.narrative_slots.since_last_week : '',
          // For the empty states (fix plan move 8) and the campaign-types line (move 3).
          data_days: ctx.ads && ctx.ads.deep && Array.isArray(ctx.ads.deep.daily) ? ctx.ads.deep.daily.length : null,
          spend_30d_usd: ctx.ads && ctx.ads.spend_30d_usd != null ? Number(ctx.ads.spend_30d_usd) : null,
          campaigns: ctx.ads && Array.isArray(ctx.ads.campaigns) ? (() => {
            const live = ctx.ads.campaigns.filter((c) => c && c.status !== 'removed');
            const by = {};
            for (const c of live) { const ch = c.channel || 'search'; by[ch] = (by[ch] || 0) + 1; }
            return { total: live.length, enabled: live.filter((c) => c.status === 'enabled').length, by_channel: by };
          })() : null,
        } : null;
        // The email (fix plan move 4): the report id is chosen up front so the
        // one-tap links can be minted and baked into the frozen HTML; a paid
        // tenant's email is rendered unlocked, with the approve link when
        // fixes are waiting.
        const reportId = require('crypto').randomUUID();
        const pendingCount = Number((drafted && (drafted.proposed ?? drafted.cards)) ?? ctx.findings.filter((f) => f.fix && f.fix.available).length) || 0;
        let htmlEmail = ctx.html_email;
        let links = {};
        if (store.mintReportLinks && ctx.envelope) {
          try {
            const baseUrl = process.env.APP_BASE_URL || 'https://app.tryinsyt.com';
            const paid = store.tenantPaid ? await store.tenantPaid(ctx.run.tenant_id) : false;
            links = await store.mintReportLinks(ctx.run.tenant_id, reportId, { baseUrl, pendingCount });
            htmlEmail = renderReport(ctx.envelope, {
              unlocked: paid, healthScore: ctx.health_score, mode: 'email',
              links: { web_url: links.view_url, unlock_url: links.view_url, approve_url: links.approve_url, settings_url: links.settings_url, pending_count: pendingCount },
            });
          } catch (e) { console.error(`report links failed for ${ctx.run.tenant_id}: ${e.message}`); }
        }
        const savedId = await store.saveReport(ctx.run.id, {
          id: reportId,
          html_email: htmlEmail,
          html_web: ctx.html_web,
          findings_snapshot: ctx.envelope ? ctx.envelope.findings : ctx.findings,
          tenant_id: ctx.run.tenant_id,
          type,
          summary,
        });
        if (store.notifyReport) {
          try {
            await store.notifyReport({
              tenantId: ctx.run.tenant_id, reportId: savedId || reportId, type, summary,
              issueCount: (ctx.envelope ? ctx.envelope.findings : ctx.findings).filter((f) => f.status !== 'dismissed' && f.status !== 'resolved').length,
              pendingCount, links, currencySymbol: (ctx.envelope && ctx.envelope.currency_symbol) || '$',
            });
          } catch (e) { console.error(`report email failed for ${ctx.run.tenant_id}: ${e.message}`); }
        }
        return { _progress: drafted || {} };
      },
    },
  ];
}

// A layer's rules only run when its stage data arrived (degraded runs skip).
function stageDataPresent(rule, ctx) {
  if (rule.layer === 1) return !!ctx.gtm;
  if (rule.layer === 2) return !!ctx.ga4;
  if (rule.layer === 3) return !!ctx.ga4Data && !!ctx.gtm;
  if (rule.layer === 4) return !!ctx.ads;
  // url.* rules ride on the verification crawl's URL sweep, not the witness.
  if (rule.rule_id && rule.rule_id.startsWith('url.')) return !!ctx.urlHealth;
  if (rule.layer === 5) return !!ctx.witness;
  // Deep rules guard internally per data block; truth.* also needs the crawl.
  if (rule.layer === 6) return rule.rule_id.startsWith('truth.') ? !!ctx.witness : true;
  return false;
}

module.exports = { buildStages, ALL_RULES, stageDataPresent };
