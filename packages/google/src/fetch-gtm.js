// GTM snapshot fetcher — produces the Layer 1 input contract documented in
// packages/rules/src/layer1-gtm.js, from GTM API v2. Quota-aware (§8): the
// caller caches the result 24h; version-number check is the cheap probe.

const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

// GTM tag parameter helpers.
function param(tag, key) {
  const p = (tag.parameter || []).find((x) => x.key === key);
  return p ? p.value : undefined;
}

function mapTag(t) {
  return {
    id: t.tagId,
    name: t.name,
    type: t.type, // 'gaawc' | 'googtag' | 'gaawe' | 'ua' | 'html' | …
    paused: !!t.paused,
    measurement_id: param(t, 'measurementId') || param(t, 'tagId') || param(t, 'trackingId'),
    event_name: param(t, 'eventName'),
    trigger_ids: (t.firingTriggerId || []).map(String),
    consent_settings: t.consentSettings ? { status: t.consentSettings.consentStatus === 'needed' ? 'set' : t.consentSettings.consentStatus } : undefined,
  };
}

/**
 * Fetch the tenant's GTM container snapshot.
 * @param {object} p { auth (client.js), tenantId, containerPublicId,
 *                     accountId?, containerId? }  — ids from the assets row
 *                     metadata when known; otherwise resolved by public id.
 */
async function fetchGtmSnapshot({ auth, tenantId, containerPublicId, accountId, containerId }) {
  // Resolve account/container when the assets metadata didn't carry them.
  if (!accountId || !containerId) {
    const accounts = await auth.api(tenantId, `${BASE}/accounts`);
    for (const acct of accounts.account || []) {
      const containers = await auth.api(tenantId, `${BASE}/${acct.path}/containers`);
      const hit = (containers.container || []).find((c) => c.publicId === containerPublicId);
      if (hit) { accountId = acct.accountId; containerId = hit.containerId; break; }
    }
    if (!accountId || !containerId) throw new Error(`container ${containerPublicId} not reachable with this connection`);
  }
  const cPath = `accounts/${accountId}/containers/${containerId}`;

  // Default workspace (first) carries the working config.
  const workspaces = await auth.api(tenantId, `${BASE}/${cPath}/workspaces`);
  const ws = (workspaces.workspace || [])[0];
  if (!ws) throw new Error('container has no workspace');
  const wPath = ws.path;

  const [tags, triggers, headers] = await Promise.all([
    auth.api(tenantId, `${BASE}/${wPath}/tags`),
    auth.api(tenantId, `${BASE}/${wPath}/triggers`),
    auth.api(tenantId, `${BASE}/${cPath}/version_headers`),
  ]);

  // Latest two versions for the regression diff; publish dates for Layer 3.
  const versionHeaders = (headers.containerVersionHeader || [])
    .filter((v) => !v.deleted)
    .sort((a, b) => Number(b.containerVersionId) - Number(a.containerVersionId));
  const loadVersion = async (h) => {
    if (!h) return null;
    const v = await auth.api(tenantId, `${BASE}/${cPath}/versions/${h.containerVersionId}`);
    return {
      version_id: Number(v.containerVersionId),
      created_at: v.fingerprint ? new Date(Number(v.fingerprint)).toISOString() : null,
      tags: (v.tag || []).map(mapTag),
    };
  };
  const [latest, previous] = await Promise.all([loadVersion(versionHeaders[0]), loadVersion(versionHeaders[1])]);

  return {
    container_public_id: containerPublicId,
    account_id: String(accountId),
    container_id: String(containerId),
    workspace_id: String(ws.workspaceId),
    tags: (tags.tag || []).map(mapTag),
    triggers: (triggers.trigger || []).map((t) => ({ id: String(t.triggerId), name: t.name, type: t.type })),
    workspace_changes: [], // workspace-status diffing lands with gtm.publish tooling
    versions: latest ? { latest, previous } : null,
    publish_dates: versionHeaders.map((h) => h.fingerprint ? new Date(Number(h.fingerprint)).toISOString().slice(0, 10) : null).filter(Boolean),
  };
}

module.exports = { fetchGtmSnapshot, mapTag };
