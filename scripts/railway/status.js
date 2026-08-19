#!/usr/bin/env node
// Railway status + logs diagnostic — prints each service's latest deployment
// state and recent logs. Read-only. Runs in GitHub Actions.

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
  // Find the project in either token mode.
  let projectList = [];
  const meRes = await gqlRaw('query { me { projects { edges { node { id name } } } } }');
  if (meRes.ok && meRes.body.data && meRes.body.data.me) projectList = meRes.body.data.me.projects.edges.map((e) => e.node);
  else {
    const pr = await gqlRaw('query { projects { edges { node { id name } } } }');
    if (pr.ok) projectList = pr.body.data.projects.edges.map((e) => e.node);
  }
  const project = projectList.find((p) => p.name === 'insyt');
  if (!project) { console.error('project insyt not found'); process.exit(1); }

  const envs = await gqlRaw('query($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }', { id: project.id });
  const environment = envs.body.data.project.environments.edges.map((e) => e.node).find((e) => e.name === 'production') || envs.body.data.project.environments.edges[0].node;
  const services = envs.body.data.project.services.edges.map((e) => e.node);

  for (const svc of services) {
    console.log(`\n===== ${svc.name} (${svc.id}) =====`);
    const deps = await gqlRaw(
      'query($input: DeploymentListInput!) { deployments(input: $input, first: 3) { edges { node { id status createdAt staticUrl } } } }',
      { input: { projectId: project.id, environmentId: environment.id, serviceId: svc.id } },
    );
    if (!deps.ok) { console.log(`deployments query failed: ${JSON.stringify(deps.body.errors).slice(0, 300)}`); continue; }
    const nodes = deps.body.data.deployments.edges.map((e) => e.node);
    if (!nodes.length) { console.log('no deployments'); continue; }
    for (const d of nodes) console.log(`${d.createdAt}  ${d.status}  ${d.staticUrl || ''}  (${d.id})`);

    const latest = nodes[0];
    for (const [label, query] of [
      ['build logs', 'query($id: String!) { buildLogs(deploymentId: $id, limit: 40) { message timestamp } }'],
      ['deploy logs', 'query($id: String!) { deploymentLogs(deploymentId: $id, limit: 40) { message timestamp } }'],
    ]) {
      const logs = await gqlRaw(query, { id: latest.id });
      const key = label === 'build logs' ? 'buildLogs' : 'deploymentLogs';
      if (logs.ok && logs.body.data[key]) {
        console.log(`--- ${label} (last ${logs.body.data[key].length}) ---`);
        for (const l of logs.body.data[key]) console.log(l.message);
      } else {
        console.log(`--- ${label}: unavailable (${JSON.stringify(logs.body.errors || {}).slice(0, 150)})`);
      }
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
