// §5.1 provisioning — Insyt does the work for a first-time advertiser:
// create the missing GA4 property (+ web data stream → measurement id) and
// the missing GTM container, on the scope ladder's write grant. Every
// created asset is recorded with created_by_us = true so it is ours to
// tidy and never mistaken for something the customer set up.
//
//   provisionMissing({ auth, db, tenantId, websiteUrl, displayName, timeZone, currency })
//     -> { ga4: { created, property_id, measurement_id } | null, gtm: { created, public_id } | null, guides: [...] }
// Honest degradation: a missing GA4/GTM *account* (the top-level thing only a
// human can create) returns a guide step instead of throwing.

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';

async function createGa4Property({ auth, tenantId, accountName, displayName, timeZone = 'Asia/Dubai', currency = 'AED', websiteUrl }) {
  const prop = await auth.api(tenantId, `${ADMIN}/properties`, {
    method: 'POST', body: JSON.stringify({ parent: accountName, displayName, timeZone, currencyCode: currency, industryCategory: 'OTHER' }),
  });
  const stream = await auth.api(tenantId, `${ADMIN}/${prop.name}/dataStreams`, {
    method: 'POST', body: JSON.stringify({ type: 'WEB_DATA_STREAM', displayName: `${displayName} web`, webStreamData: { defaultUri: websiteUrl } }),
  });
  return { property_id: prop.name.split('/').pop(), measurement_id: stream.webStreamData && stream.webStreamData.measurementId, stream_id: stream.name };
}

async function createGtmContainer({ auth, tenantId, accountId, name, domain }) {
  const c = await auth.api(tenantId, `${GTM}/accounts/${accountId}/containers`, {
    method: 'POST', body: JSON.stringify({ name, usageContext: ['web'], domainName: domain ? [domain] : [] }),
  });
  return { public_id: c.publicId, container_id: c.containerId, account_id: accountId };
}

async function provisionMissing({ auth, db, tenantId, websiteUrl, displayName, timeZone, currency }) {
  const q = (s) => encodeURIComponent(s);
  const linked = await db.select('assets', `tenant_id=eq.${q(tenantId)}&linked=eq.true&select=kind,external_id`).catch(() => []);
  const has = (k) => (linked || []).some((a) => a.kind === k);
  const out = { ga4: null, gtm: null, guides: [] };
  const domain = (() => { try { return new URL(websiteUrl).hostname; } catch { return null; } })();

  if (!has('ga4_property')) {
    const accounts = await auth.api(tenantId, `${ADMIN}/accounts`).catch(() => ({}));
    const acct = (accounts.accounts || [])[0];
    if (!acct) {
      out.guides.push({ key: 'ga4_account', label: 'Create a Google Analytics account', detail: 'Google only lets a person create the top-level account. It takes one minute; we do everything after that.', url: 'https://analytics.google.com/' });
    } else {
      const r = await createGa4Property({ auth, tenantId, accountName: acct.name, displayName, timeZone, currency, websiteUrl });
      await db.insert('assets', [{ tenant_id: tenantId, kind: 'ga4_property', external_id: r.property_id, display_name: displayName, currency, linked: true, created_by_us: true, metadata: { measurement_ids: [r.measurement_id], stream_id: r.stream_id } }], { returning: false }).catch(() => {});
      out.ga4 = { created: true, ...r };
    }
  }
  if (!has('gtm_container')) {
    const accounts = await auth.api(tenantId, `${GTM}/accounts`).catch(() => ({}));
    const acct = (accounts.account || [])[0];
    if (!acct) {
      out.guides.push({ key: 'gtm_account', label: 'Create a Google Tag Manager account', detail: 'One minute on Google\'s side; we create and set up the tracking code after that.', url: 'https://tagmanager.google.com/' });
    } else {
      const r = await createGtmContainer({ auth, tenantId, accountId: acct.accountId, name: displayName, domain });
      await db.insert('assets', [{ tenant_id: tenantId, kind: 'gtm_container', external_id: r.public_id, display_name: displayName, linked: true, created_by_us: true, metadata: { account_id: r.account_id, container_id: r.container_id } }], { returning: false }).catch(() => {});
      out.gtm = { created: true, ...r };
    }
  }
  if (out.ga4 || out.gtm) {
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'connection_changed', actor: 'system',
      summary_text: `We set up ${[out.ga4 && 'visit tracking', out.gtm && 'the tracking code'].filter(Boolean).join(' and ')} for you. Nothing to configure.` }], { returning: false }).catch(() => {});
  }
  return out;
}

module.exports = { provisionMissing, createGa4Property, createGtmContainer };
