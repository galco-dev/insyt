// The §8 stage list, wiring the existing packages. Each stage's external
// I/O goes through injected clients so the pipeline tests offline and the
// Railway service supplies real ones.
//
// buildStages({ google, crawler, model, store }) -> ordered stage array
//   google:  { fetchGtmSnapshot(tenant), fetchGa4Config(tenant),
//              fetchGa4Data(tenant), fetchAds(tenant) }   (real API clients later)
//   crawler: { verificationCrawl(url) }
//   model:   { generate({system, prompt}) }                (Anthropic client)
//   store:   { ruleConfig(), priorFindings(tenantId), ledgerCumulative(tenantId),
//              saveFindings(runId, findings), saveReport(runId, {html_email, html_web, findings}) }

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
const { narrateFinding, narrateSlots } = require('../../../packages/report/src/narration');
const { renderReport } = require('../../../packages/report/src/render');

const ALL_RULES = [...l1.rules, ...l2.rules, ...l3.rules, ...l4.rules, ...l4rsa.rules, ...l5.rules, ...l5urls.rules, ...l6.rules];

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
        return { ads, _progress: { search_terms_reviewed: (ads.search_terms || []).length } };
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
            now,
          },
          priorFindings: await store.priorFindings(ctx.run.tenant_id),
          runId: ctx.run.id,
          tenantId: ctx.run.tenant_id,
        });
        return { findings, ruleErrors: errors, counts, _progress: { findings: findings.length } };
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
      run: async (ctx) => {
        const findings = [];
        for (const f of ctx.findings) {
          try {
            const { title, explanation } = await narrateFinding(f, model.generate);
            findings.push({ ...f, title, explanation });
          } catch {
            // Grounding failed twice — fall back to the payload-free fix_detail-less engine framing.
            findings.push({ ...f, title: f.rule_id.replace(/[._]/g, ' '), explanation: '' });
          }
        }
        const slots = await narrateSlots({ counts: ctx.counts, totals: { waste: null }, previousWeek: null }, model.generate)
          .catch(() => ({ exec_summary: '', since_last_week: '' }));
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
        const envelope = assembleEnvelope({
          run: { id: ctx.run.id, type: ctx.run.type, status: 'complete' },
          findings: ctx.findings,
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
        await store.saveReport(ctx.run.id, {
          html_email: ctx.html_email,
          html_web: ctx.html_web,
          findings_snapshot: ctx.envelope.findings,
          tenant_id: ctx.run.tenant_id,
          type: ctx.run.type === 'signup_audit' ? 'signup' : ctx.run.type === 'deep' ? 'deep' : 'weekly',
        });
        return {};
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
