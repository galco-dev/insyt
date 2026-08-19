#!/usr/bin/env node
// Idempotent DNS-as-code for tryinsyt.com — runs in GitHub Actions with a
// zone-scoped CLOUDFLARE_API_TOKEN (Edit zone DNS on tryinsyt.com only).
// Ensures the §17 Resend sending records exist; never deletes anything.
// Re-run safe: existing records with the same type+name are left untouched
// unless content differs (then updated).

const ZONE_NAME = 'tryinsyt.com';
const API = 'https://api.cloudflare.com/client/v4';

// All names relative to the zone root get the zone appended by CF automatically
// when given as FQDN; we use FQDNs to be unambiguous.
const RECORDS = [
  { type: 'TXT', name: `resend._domainkey.alerts.${ZONE_NAME}`, content: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDX8PNyvx4wAorrHJkY3ZIr6w50bbSeia9Rpof24e0PyHtbIvv8WgIQCKUO+RvHMP6GJtePPmLq9d8PabYp+c5O+V2CCZ7iIhN1ZP2JtYhYoPqlWRRHQLYgHC/K+FjhErEN8/sAnv2UZ0nYFiHABTRMumU2wiWucCBNXzezfkDRHwIDAQAB' },
  { type: 'MX', name: `send.alerts.${ZONE_NAME}`, content: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
  { type: 'TXT', name: `send.alerts.${ZONE_NAME}`, content: 'v=spf1 include:amazonses.com ~all' },
  { type: 'TXT', name: `resend._domainkey.mail.${ZONE_NAME}`, content: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDUfYCPvpwNIGfhORBNEc9T2Il/rPO+aF3rj69abHZZkZfCSPwdlixFea4idcB2XK4usfP7iJsWMEVkbPJcF3L+vHiIdBYZWH0rjbcBRZ8jDqPdDs+2K8NggPa+9RzcJQVUi7IGVRVEmXlSVk0nldYJJIzOFbzDmq7Qkv6x6B7tdQIDAQAB' },
  { type: 'MX', name: `send.mail.${ZONE_NAME}`, content: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
  { type: 'TXT', name: `send.mail.${ZONE_NAME}`, content: 'v=spf1 include:amazonses.com ~all' },
  // DMARC for the org domain — monitoring policy to start (§17 requires DMARC
  // before first send; p=none observes without breaking anything).
  { type: 'TXT', name: `_dmarc.${ZONE_NAME}`, content: 'v=DMARC1; p=none; rua=mailto:galledarim@gmail.com' },
];

// Optional: app.tryinsyt.com → Railway. Set RAILWAY_WEB_DOMAIN (e.g.
// web-production-xxxx.up.railway.app) to have it created as a proxied-off CNAME.
if (process.env.RAILWAY_WEB_DOMAIN) {
  RECORDS.push({ type: 'CNAME', name: `app.${ZONE_NAME}`, content: process.env.RAILWAY_WEB_DOMAIN, proxied: false });
}

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(`cloudflare ${method} ${path}: ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  return json.result;
}

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN) { console.error('CLOUDFLARE_API_TOKEN required'); process.exit(1); }
  const zones = await cf('GET', `/zones?name=${ZONE_NAME}`);
  if (!zones.length) throw new Error(`zone ${ZONE_NAME} not visible to this token — scope it to the zone`);
  const zoneId = zones[0].id;
  console.log(`zone ${ZONE_NAME}: ${zoneId}`);

  const existing = await cf('GET', `/zones/${zoneId}/dns_records?per_page=200`);
  const byKey = new Map(existing.map((r) => [`${r.type}:${r.name}`, r]));

  for (const spec of RECORDS) {
    const key = `${spec.type}:${spec.name}`;
    const have = byKey.get(key);
    const payload = { type: spec.type, name: spec.name, content: spec.content, ttl: 1, proxied: spec.proxied ?? false, ...(spec.priority ? { priority: spec.priority } : {}) };
    if (!have) {
      await cf('POST', `/zones/${zoneId}/dns_records`, payload);
      console.log(`created ${key}`);
    } else if (have.content.replace(/"/g, '') !== spec.content.replace(/"/g, '')) {
      await cf('PUT', `/zones/${zoneId}/dns_records/${have.id}`, payload);
      console.log(`updated ${key}`);
    } else {
      console.log(`ok      ${key}`);
    }
  }
  console.log('\nDNS complete.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
