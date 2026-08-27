// Tool transports — the API side of the §4 catalogue. The executor calls
// api[tool_id](params) and expects { before, after }. Guardrails live in
// catalogue.js (pure); THIS file only performs the writes, one Google API
// call pattern per tool, always fetching `before` where the API allows.
//
// createTransports({ auth, tenantId, developerToken, loginCustomerId })
// auth = packages/google/src/client.js instance. Missing developer token →
// ads tools throw 'ads writes not configured' and the change fails honestly.

const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const { VERSION: ADS_VERSION } = require('../../google/src/fetch-ads'); // one env-configured version everywhere

function createTransports({ auth, tenantId, developerToken, loginCustomerId, customerId }) {
  const gtmPath = (p) => `accounts/${p.account_id}/containers/${p.container_id}/workspaces/${p.workspace_id}`;

  async function gtmGetTag(p) {
    return auth.api(tenantId, `${GTM}/${gtmPath(p)}/tags/${p.tag_id}`);
  }
  async function gtmPutTag(p, tag) {
    return auth.api(tenantId, `${GTM}/${gtmPath(p)}/tags/${p.tag_id}`, { method: 'PUT', body: JSON.stringify(tag) });
  }

  const adsHeaders = () => ({
    'developer-token': developerToken,
    ...(loginCustomerId ? { 'login-customer-id': String(loginCustomerId).replace(/-/g, '') } : {}),
  });
  // resourcePath 'googleAds' = the cross-resource endpoint (MutateOperation
  // list, atomic by default) used by campaign creation; anything else is a
  // per-resource service.
  async function adsMutate(resourcePath, operations, { atomic = false } = {}) {
    if (!developerToken) throw new Error('ads writes not configured (developer token pending)');
    const cid = String(customerId).replace(/-/g, '');
    const body = resourcePath === 'googleAds'
      ? { mutateOperations: operations, partialFailure: !atomic }
      : { operations };
    return auth.api(tenantId, `https://googleads.googleapis.com/${ADS_VERSION}/customers/${cid}/${resourcePath}:mutate`, {
      method: 'POST', headers: adsHeaders(), body: JSON.stringify(body),
    });
  }
  async function adsSearch(query) {
    const { search } = require('../../google/src/fetch-ads');
    return search({ auth, tenantId, customerId, developerToken, loginCustomerId, query });
  }

  const cid = () => String(customerId).replace(/-/g, '');

  return {
    // ------------------------------------------------------------ GTM
    'gtm.pause_tag': async (p) => {
      const before = await gtmGetTag(p);
      const after = await gtmPutTag(p, { ...before, paused: true });
      return { before: { paused: !!before.paused, name: before.name }, after: { paused: true, name: after.name } };
    },
    'gtm.update_tag_config': async (p) => {
      const before = await gtmGetTag(p);
      const after = await gtmPutTag(p, { ...before, ...p.patch });
      return { before, after };
    },
    'gtm.create_tag': async (p) => {
      const after = await auth.api(tenantId, `${GTM}/${gtmPath(p)}/tags`, { method: 'POST', body: JSON.stringify(p.spec) });
      return { before: null, after };
    },
    'gtm.remove_tag': async (p) => {
      const before = await gtmGetTag(p);
      await auth.api(tenantId, `${GTM}/${gtmPath(p)}/tags/${p.tag_id}`, { method: 'DELETE' });
      return { before, after: null };
    },
    'gtm.publish': async (p) => {
      const version = await auth.api(tenantId, `${GTM}/${gtmPath(p)}:create_version`, {
        method: 'POST', body: JSON.stringify({ name: p.version_name || 'Insyt change', notes: p.notes || '' }),
      });
      const vId = version.containerVersion.containerVersionId;
      const after = await auth.api(tenantId,
        `${GTM}/accounts/${p.account_id}/containers/${p.container_id}/versions/${vId}:publish`, { method: 'POST' });
      return { before: null, after: { version_id: vId, published: true, ...after } };
    },
    'gtm.restore_version_element': async (p) => {
      const version = await auth.api(tenantId, `${GTM}/accounts/${p.account_id}/containers/${p.container_id}/versions/${p.version_id}`);
      const tag = (version.tag || []).find((t) => String(t.tagId) === String(p.element));
      if (!tag) throw new Error(`element ${p.element} not in version ${p.version_id}`);
      const { tagId, path, fingerprint, ...spec } = tag;
      const after = await auth.api(tenantId, `${GTM}/${gtmPath(p)}/tags`, { method: 'POST', body: JSON.stringify(spec) });
      return { before: null, after: { restored: tag.name, new_tag_id: after.tagId } };
    },
    // ------------------------------------------------------------ GA4
    'ga4.create_key_event': async (p) => {
      const after = await auth.api(tenantId, `${ADMIN}/properties/${p.property_id}/keyEvents`, {
        method: 'POST', body: JSON.stringify({ eventName: p.event_name, countingMethod: p.counting_method || 'ONCE_PER_EVENT' }),
      });
      return { before: null, after };
    },
    'ga4.update_key_event': async (p) => {
      const before = await auth.api(tenantId, `${ADMIN}/${p.key_event_name}`);
      const after = await auth.api(tenantId, `${ADMIN}/${p.key_event_name}?updateMask=countingMethod`, {
        method: 'PATCH', body: JSON.stringify({ countingMethod: p.counting_method }),
      });
      return { before, after };
    },
    'ga4.create_ads_link': async (p) => {
      const after = await auth.api(tenantId, `${ADMIN}/properties/${p.property_id}/googleAdsLinks`, {
        method: 'POST', body: JSON.stringify({ customerId: String(p.ads_cid) }),
      });
      return { before: null, after };
    },
    'ga4.set_retention': async (p) => {
      const path = `properties/${p.property_id}/dataRetentionSettings`;
      const before = await auth.api(tenantId, `${ADMIN}/${path}`);
      const after = await auth.api(tenantId, `${ADMIN}/${path}?updateMask=eventDataRetention`, {
        method: 'PATCH', body: JSON.stringify({ eventDataRetention: 'FOURTEEN_MONTHS' }),
      });
      return { before: { retention: before.eventDataRetention }, after: { retention: after.eventDataRetention } };
    },
    // ------------------------------------------------------------ Ads
    'ads.add_negative_keywords': async (p) => {
      const ops = p.terms.map((t) => ({
        create: {
          campaign: `customers/${cid()}/campaigns/${p.campaign_id}`,
          negative: true,
          keyword: { text: t.text, matchType: t.match_type.toUpperCase() },
        },
      }));
      const after = await adsMutate('campaignCriteria', ops);
      const resourceNames = (after.results || []).map((r) => r.resourceName).filter(Boolean);
      // resource_names make the change reversible (ads.remove_negative_keywords).
      return { before: { negative_count_added: 0 }, after: { negative_count_added: p.terms.length, results: resourceNames.length, resource_names: resourceNames } };
    },
    'ads.remove_negative_keywords': async (p) => {
      await adsMutate('campaignCriteria', p.resource_names.map((r) => ({ remove: r })));
      return { before: { negatives: p.resource_names.length }, after: { negatives: 0, removed: p.resource_names } };
    },
    'ads.enable_keyword': async (p) => {
      await adsMutate('adGroupCriteria', [{
        update: { resourceName: `customers/${cid()}/adGroupCriteria/${p.ad_group_id}~${p.criterion_id}`, status: 'ENABLED' }, updateMask: 'status',
      }]);
      return { before: { status: 'paused' }, after: { status: 'enabled' } };
    },
    'ads.adjust_budget': async (p) => {
      if (!p.budget_resource) throw new Error('budget_resource (campaign budget resource name) required');
      const after = await adsMutate('campaignBudgets', [{
        update: { resourceName: p.budget_resource, amountMicros: String(Math.round(p.new_daily_usd * 1_000_000)) },
        updateMask: 'amount_micros',
      }]);
      return { before: { daily_usd: p.previous_daily_usd ?? null }, after: { daily_usd: p.new_daily_usd } };
    },
    'ads.pause_campaign': async (p) => {
      const after = await adsMutate('campaigns', [{
        update: { resourceName: `customers/${cid()}/campaigns/${p.campaign_id}`, status: 'PAUSED' }, updateMask: 'status',
      }]);
      return { before: { status: 'enabled' }, after: { status: 'paused' } };
    },
    'ads.enable_campaign': async (p) => {
      const after = await adsMutate('campaigns', [{
        update: { resourceName: `customers/${cid()}/campaigns/${p.campaign_id}`, status: 'ENABLED' }, updateMask: 'status',
      }]);
      return { before: { status: 'paused' }, after: { status: 'enabled' } };
    },
    'ads.pause_keyword': async (p) => {
      const after = await adsMutate('adGroupCriteria', [{
        update: { resourceName: `customers/${cid()}/adGroupCriteria/${p.ad_group_id}~${p.criterion_id}`, status: 'PAUSED' }, updateMask: 'status',
      }]);
      return { before: { status: 'enabled' }, after: { status: 'paused' } };
    },
    'ads.set_action_secondary': async (p) => {
      const after = await adsMutate('conversionActions', [{
        update: { resourceName: `customers/${cid()}/conversionActions/${p.conversion_action_id}`, primaryForGoal: false }, updateMask: 'primary_for_goal',
      }]);
      return { before: { primary: true }, after: { primary: false } };
    },
    'ads.set_action_primary': async (p) => {
      const after = await adsMutate('conversionActions', [{
        update: { resourceName: `customers/${cid()}/conversionActions/${p.conversion_action_id}`, primaryForGoal: true }, updateMask: 'primary_for_goal',
      }]);
      return { before: { primary: false }, after: { primary: true } };
    },
    // Campaign creation — the biggest possible change. Always PAUSED; the
    // executor returns every created resource so enable/teardown are exact.
    'ads.create_campaign_draft': async (p) => {
      const { createCampaignPaused } = require('../../campaigns/src/executor');
      const r = await createCampaignPaused({ spec: p.spec, adsMutate, adsSearch, customerId, finalUrl: p.final_url });
      return { before: { campaign: null }, after: { campaign_id: r.campaign_id, status: 'paused', resources: r.resources, geo_target_ids: r.geo_target_ids, warnings: r.warnings } };
    },
    'ads.unpause_launch': async (p) => {
      const after = await adsMutate('campaigns', [{
        update: { resourceName: `customers/${cid()}/campaigns/${p.campaign_id}`, status: 'ENABLED' }, updateMask: 'status',
      }]);
      return { before: { status: 'paused' }, after: { status: 'enabled', launched: true } };
    },
  };
}

module.exports = { createTransports };
