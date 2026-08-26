#!/usr/bin/env node
// Provision the Insyt Railway project — build-doc §15 topology.
// Runs inside GitHub Actions (the Cowork sandbox cannot reach Railway's API).
// Idempotent: safe to re-run; it finds-or-creates everything by name.
// Works with BOTH personal account tokens (me.projects) and workspace/team
// tokens (top-level projects + teamId on create).
//
//   RAILWAY_TOKEN=... node scripts/railway/provision.js
//
// Creates: project "insyt" → services web/worker/poller/cron (+ redis from
// image, with volume) → start/build commands → env vars. Secrets are passed
// through from the environment when present (see PASSTHROUGH below) and
// reported as MISSING otherwise — deploys still go out; services that need a
// missing secret exit loudly at boot, which is the §15-honest failure mode.

const crypto = require('crypto');

const API = 'https://backboard.railway.com/graphql/v2';

const SERVICES = [
  { name: 'web', start: 'npm run start:web', build: 'npm ci && npx playwright install chromium --with-deps && npm run build:client' },
  { name: 'worker', start: 'npm run start:worker', build: 'npm ci && npx playwright install chromium --with-deps' },
  { name: 'poller', start: 'npm run start:poller', build: 'npm ci && npx playwright install chromium --with-deps' },
  { name: 'cron', start: 'npm run start:cron', build: 'npm ci' },
];

const PASSTHROUGH = [
  'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'INSYT_MODEL_ID',
  'GOOGLE_ADS_DEVELOPER_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'SENTRY_DSN',
];

async function gqlRaw(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RAILWAY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.errors, body };
}

async function gql(query, variables = {}) {
  const { ok, body } = await gqlRaw(query, variables);
  if (!ok) throw new Error(`railway api: ${JSON.stringify(body.errors || body).slice(0, 500)}`);
  return body.data;
}

async function main() {
  if (!process.env.RAILWAY_TOKEN) { console.error('RAILWAY_TOKEN required'); process.exit(1); }

  // 1. Project (find or create) — dual token mode.
  let projectList = null;
  let teamId = null;
  const meRes = await gqlRaw('query { me { name email projects { edges { node { id name } } } } }');
  if (meRes.ok && meRes.body.data && meRes.body.data.me) {
    const me = meRes.body.data.me;
    console.log(`token ok — account mode: ${me.email || me.name}`);
    projectList = me.projects.edges.map((e) => e.node);
  } else {
    const pr = await gqlRaw('query { projects { edges { node { id name } } } }');
    if (!pr.ok || !pr.body.data || !pr.body.data.projects) {
      throw new Error(`token rejected in both account and workspace modes: ${JSON.stringify(pr.body.errors || meRes.body.errors).slice(0, 400)}`);
    }
    projectList = pr.body.data.projects.edges.map((e) => e.node);
    const teams = await gqlRaw('query { teams { edges { node { id name } } } }');
    if (teams.ok && teams.body.data && teams.body.data.teams && teams.body.data.teams.edges[0]) {
      teamId = teams.body.data.teams.edges[0].node.id;
    }
    console.log(`token ok — workspace mode${teamId ? ` (team ${teamId})` : ''}; ${projectList.length} project(s) visible`);
  }

  let project = projectList.find((p) => p.name === 'insyt');
  if (!project) {
    const input = { name: 'insyt', description: 'Insyt — build-doc §15 services', ...(teamId ? { teamId } : {}) };
    project = (await gql('mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }', { input })).projectCreate;
    console.log(`created project ${project.id}`);
  } else {
    console.log(`found project ${project.id}`);
  }

  // 2. Production environment id + existing services.
  const envs = await gql('query($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }', { id: project.id });
  const environment = envs.project.environments.edges.map((e) => e.node).find((e) => e.name === 'production')
    || envs.project.environments.edges[0].node;
  const existing = new Map(envs.project.services.edges.map((e) => [e.node.name, e.node]));
  console.log(`environment: ${environment.name} (${environment.id})`);

  const results = { created: [], updated: [], missing_secrets: [] };

  // 3. Redis — image service with a volume; app services reach it over
  // private networking at redis.railway.internal. The password is STABLE:
  // reuse whatever the existing instance's start command carries, so app
  // REDIS_URLs always match the running server; generate only on creation.
  let redisPassword = process.env.REDIS_PASSWORD || null;
  let redisCreated = false;
  if (!existing.has('redis')) {
    const svc = (await gql('mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }',
      { input: { projectId: project.id, name: 'redis', source: { image: 'redis:7-alpine' } } })).serviceCreate;
    existing.set('redis', svc);
    results.created.push('redis');
    redisCreated = true;
    await gql('mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }',
      { input: { projectId: project.id, environmentId: environment.id, serviceId: svc.id, mountPath: '/data' } })
      .catch((e) => console.warn(`volume: ${e.message}`));
  }
  const redisId = existing.get('redis').id;
  if (!redisPassword) {
    const inst = await gqlRaw(
      'query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { startCommand } }',
      { serviceId: redisId, environmentId: environment.id },
    );
    const cmd = inst.ok && inst.body.data.serviceInstance ? inst.body.data.serviceInstance.startCommand : null;
    const m = cmd && /--requirepass\s+(\S+)/.exec(cmd);
    redisPassword = m ? m[1] : crypto.randomBytes(24).toString('hex');
    if (!m) console.log('redis: no existing password found — generated a new one (redis will be redeployed)');
  }
  const desiredRedisCmd = `redis-server --requirepass ${redisPassword} --appendonly yes --dir /data`;
  await gql('mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
    { serviceId: redisId, environmentId: environment.id, input: { startCommand: desiredRedisCmd } })
    .catch((e) => console.warn(`redis start command: ${e.message}`));
  // One redeploy so the RUNNING redis matches the current password (converges
  // the earlier password drift; harmless when already matching).
  await gql('mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }',
    { serviceId: redisId, environmentId: environment.id })
    .then(() => console.log('redis: redeployed with current password'))
    .catch((e) => console.warn(`redis redeploy: ${e.message}${redisCreated ? ' (fresh create deploys itself)' : ''}`));
  const redisUrl = `redis://default:${redisPassword}@redis.railway.internal:6379`;

  // 4. App services.
  const shared = {
    SUPABASE_URL: process.env.SUPABASE_URL || 'https://riwkekblrvarvfyqmdpq.supabase.co',
    REDIS_URL: redisUrl,
    APP_BASE_URL: process.env.APP_BASE_URL || 'https://app.tryinsyt.com',
    SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    OPS_TOKEN: process.env.OPS_TOKEN || crypto.randomBytes(24).toString('base64url'),
  };
  for (const key of PASSTHROUGH) {
    if (process.env[key]) shared[key] = process.env[key];
    else results.missing_secrets.push(key);
  }

  for (const spec of SERVICES) {
    let svc = existing.get(spec.name);
    if (!svc) {
      svc = (await gql('mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }',
        { input: { projectId: project.id, name: spec.name } })).serviceCreate;
      existing.set(spec.name, svc);
      results.created.push(spec.name);
    } else {
      results.updated.push(spec.name);
    }
    await gql('mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
      { serviceId: svc.id, environmentId: environment.id, input: { startCommand: spec.start, buildCommand: spec.build } })
      .catch((e) => console.warn(`${spec.name} commands: ${e.message}`));
    for (const [name, value] of Object.entries(shared)) {
      await gql('mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
        { input: { projectId: project.id, environmentId: environment.id, serviceId: svc.id, name, value } })
        .catch((e) => console.warn(`${spec.name}.${name}: ${e.message}`));
    }
  }

  // 5. Public domain for web.
  await gql('mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }',
    { input: { environmentId: environment.id, serviceId: existing.get('web').id } })
    .then((d) => console.log(`web domain: ${d.serviceDomainCreate.domain}`))
    .catch((e) => console.warn(`web domain: ${e.message} (may already exist)`));

  console.log('\n=== PROVISION SUMMARY ===');
  console.log(`created: ${results.created.join(', ') || 'nothing (all existed)'}`);
  console.log(`updated: ${results.updated.join(', ') || '—'}`);
  console.log(`missing secrets (add as GitHub repo secrets and re-run): ${results.missing_secrets.join(', ') || 'none'}`);
  console.log('service ids:', JSON.stringify(Object.fromEntries([...existing].map(([n, s]) => [n, s.id]))));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
