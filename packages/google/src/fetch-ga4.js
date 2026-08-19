// GA4 fetchers — produce the Layer 2 (config) and Layer 3 (data) input
// contracts documented in packages/rules/src/layer2-ga4.js / layer3-fire.js.
// Admin API v1beta for config; Data API v1beta for event volumes.

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';

/** Layer 2 contract: the property's configuration. */
async function fetchGa4Config({ auth, tenantId, propertyId }) {
  const p = `properties/${propertyId}`;
  const [keyEvents, adsLinks, retention, streams, attribution] = await Promise.all([
    auth.api(tenantId, `${ADMIN}/${p}/keyEvents`),
    auth.api(tenantId, `${ADMIN}/${p}/googleAdsLinks`),
    auth.api(tenantId, `${ADMIN}/${p}/dataRetentionSettings`),
    auth.api(tenantId, `${ADMIN}/${p}/dataStreams`),
    auth.api(tenantId, `${ADMIN}/${p}/attributionSettings`).catch(() => null),
  ]);

  // Enhanced measurement rides on the web stream(s).
  const webStreams = (streams.dataStreams || []).filter((s) => s.type === 'WEB_DATA_STREAM');
  let enhanced = { enabled: false, events: [] };
  for (const s of webStreams) {
    const em = await auth.api(tenantId, `${ADMIN}/${s.name}/enhancedMeasurementSettings`).catch(() => null);
    if (em && em.streamEnabled) {
      enhanced = {
        enabled: true,
        events: [
          em.scrollsEnabled && 'scroll', em.outboundClicksEnabled && 'click',
          em.siteSearchEnabled && 'view_search_results', em.videoEngagementEnabled && 'video_start',
          em.fileDownloadsEnabled && 'file_download', em.pageChangesEnabled && 'page_view',
          em.formInteractionsEnabled && 'form_start',
        ].filter(Boolean),
      };
    }
  }

  const retentionMap = { TWO_MONTHS: 2, FOURTEEN_MONTHS: 14, TWENTY_SIX_MONTHS: 26, THIRTY_EIGHT_MONTHS: 38, FIFTY_MONTHS: 50 };
  return {
    property_id: String(propertyId),
    key_events: (keyEvents.keyEvents || []).map((k) => ({
      name: k.name, event_name: k.eventName, counting_method: k.countingMethod, create_time: k.createTime,
    })),
    ads_links: (adsLinks.googleAdsLinks || []).map((l) => ({ customer_id: l.customerId, create_time: l.createTime })),
    retention_months: retentionMap[retention.eventDataRetention] ?? 14,
    enhanced_measurement: enhanced,
    attribution: attribution ? {
      model: attribution.reportingAttributionModel,
      is_default: attribution.reportingAttributionModel === 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN',
      changed_at: null, // Admin API exposes no change history; version tracking via our own audit later
    } : { model: 'unknown', is_default: true, changed_at: null },
    measurement_ids: webStreams.map((s) => s.webStreamData && s.webStreamData.measurementId).filter(Boolean),
  };
}

/** Layer 3 contract: event volume time-series + sessions. 56 days of daily data. */
async function fetchGa4Data({ auth, tenantId, propertyId, windowDays = 30, historyDays = 56 }) {
  const p = `properties/${propertyId}`;
  const report = await auth.api(tenantId, `${DATA}/${p}:runReport`, {
    method: 'POST',
    body: JSON.stringify({
      dateRanges: [{ startDate: `${historyDays}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'eventName' }, { name: 'date' }],
      metrics: [{ name: 'eventCount' }],
      limit: 100000,
    }),
  });
  const sessionsReport = await auth.api(tenantId, `${DATA}/${p}:runReport`, {
    method: 'POST',
    body: JSON.stringify({
      dateRanges: [{ startDate: `${windowDays}daysAgo`, endDate: 'today' }],
      metrics: [{ name: 'sessions' }],
    }),
  });

  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const byEvent = new Map();
  for (const row of report.rows || []) {
    const [eventName, date] = row.dimensionValues.map((d) => d.value);
    const count = Number(row.metricValues[0].value);
    if (!byEvent.has(eventName)) byEvent.set(eventName, { event_name: eventName, total_30d: 0, daily: [] });
    const ev = byEvent.get(eventName);
    ev.daily.push({ date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, count });
    if (date >= cutoff) ev.total_30d += count;
  }
  for (const ev of byEvent.values()) ev.daily.sort((a, b) => (a.date < b.date ? -1 : 1));

  const sessions = sessionsReport.rows && sessionsReport.rows[0]
    ? Number(sessionsReport.rows[0].metricValues[0].value) : 0;

  return { window_days: windowDays, sessions_30d: sessions, events: [...byEvent.values()] };
}

module.exports = { fetchGa4Config, fetchGa4Data };
