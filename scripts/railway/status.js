#!/usr/bin/env node
// Railway status + logs diagnostic — project-wide view. Read-only.
// Prints: environments, per-service instance config (start/build commands),
// ALL recent deployments in the project (any environment/service), and logs
// for the latest deployment of each service.

const API = 'https://backboard.railway.com/graphql/v2';

async function gqlRaw(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RAILWAY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.errors, body };
}

async function main() {
  let projectList = [];
  const meRes = await gqlRaw('query { me { projects { edges { node { id name } } } } }');
  if (meRes.ok && meRes.body.data && meRes.body.data.me) projectList = meRes.body.data.me.projects.edges.map((e) => e.node);
  else {
    const pr = await gqlRaw('query { projects { edges { node { id name } } } }');
    if (pr.ok) projectList = pr.body.data.projects.edges.map((e) => e.node);
  }
  const project = projectList.find((p) => p.name === 'insyt');
  if (!project) { console.error('project insyt not found; visible: ' + projectList.map((p) => p.name).join(', ')); process.exit(1); }
  console.log(`project insyt: ${project.id}`);

  const envs = await gqlRaw('query($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }', { id: project.id });
  const environments = envs.body.data.project.environments.edges.map((e) => e.node);
  const services = envs.body.data.project.services.edges.map((e) => e.node);
  console.log(`environments: ${environments.map((e) => `${e.name}(${e.id})`).join(' · ')}`);
  console.log(`services: ${services.map((s) => s.name).join(' · ')}`);

  // Per-service instance config in each environment.
  for (const svc of services) {
    for (const env of environments) {
      const inst = await gqlRaw(
        'query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { startCommand buildCommand source { repo image } } }',
        { serviceId: svc.id, environmentId: env.id },
      );
      if (inst.ok && inst.body.data.serviceInstance) {
        const i = inst.body.data.serviceInstance;
        console.log(`instance ${svc.name}@${env.name}: start=${JSON.stringify(i.startCommand)} build=${JSON.stringify(i.buildCommand)} source=${JSON.stringify(i.source)}`);
      } else {
        console.log(`instance ${svc.name}@${env.name}: unavailable ${JSON.stringify((inst.body.errors || [])).slice(0, 200)}`);
      }
    }
  }

  // Project-wide deployments — no service/environment filter.
  const all = await gqlRaw(
    'query($input: DeploymentListInput!) { deployments(input: $input, first: 20) { edges { node { id status createdAt serviceId environmentId staticUrl } } } }',
    { input: { projectId: project.id } },
  );
  console.log('\n===== ALL project deployments (latest 20) =====');
  if (!all.ok) console.log(`query failed: ${JSON.stringify(all.body.errors).slice(0, 300)}`);
  else {
    const nodes = all.body.data.deployments.edges.map((e) => e.node);
    if (!nodes.length) console.log('NONE — nothing has ever deployed in this project except what shows below per-service.');
    const svcName = new Map(services.map((s) => [s.id, s.name]));
    const envName = new Map(environments.map((e) => [e.id, e.name]));
    for (const d of nodes) {
      console.log(`${d.createdAt}  ${String(d.status).padEnd(9)} ${svcName.get(d.serviceId) || d.serviceId}@${envName.get(d.environmentId) || d.environmentId}  ${d.staticUrl || ''}  (${d.id})`);
    }

    // Logs for the latest deployment of each non-SUCCESS service.
    const latestBySvc = new Map();
    for (const d of nodes) if (!latestBySvc.has(d.serviceId)) latestBySvc.set(d.serviceId, d);
    for (const [sid, d] of latestBySvc) {
      console.log(`\n----- logs: ${svcName.get(sid) || sid} (${d.status}) -----`);
      for (const [label, query, key] of [
        ['build', 'query($id: String!) { buildLogs(deploymentId: $id, limit: 60) { message } }', 'buildLogs'],
        ['deploy', 'query($id: String!) { deploymentLogs(deploymentId: $id, limit: 60) { message } }', 'deploymentLogs'],
      ]) {
        const logs = await gqlRaw(query, { id: d.id });
        if (logs.ok && logs.body.data[key] && logs.body.data[key].length) {
          console.log(`--- ${label} ---`);
          for (const l of logs.body.data[key]) console.log(l.message);
        }
      }
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
