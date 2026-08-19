#!/usr/bin/env node
// Railway preflight — verbose diagnostics for the provision workflow.
// Probes ALL token modes (account/workspace/team) and prints every response.
// Never prints the token itself.

const API = 'https://backboard.railway.com/graphql/v2';

async function main() {
  const token = process.env.RAILWAY_TOKEN;
  console.log(`RAILWAY_TOKEN present: ${!!token}${token ? ` (length ${token.length}, starts ${token.slice(0, 4)}…)` : ''}`);
  if (!token) {
    console.error('FAIL: the RAILWAY_TOKEN repo secret is not reaching the job. Check the secret name is exactly RAILWAY_TOKEN.');
    process.exit(1);
  }

  const probe = async (label, query) => {
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    console.log(`\n--- ${label} ---`);
    console.log(`HTTP ${res.status}: ${text.slice(0, 800)}`);
    try { return JSON.parse(text); } catch { return {}; }
  };

  const me = await probe('me (account token mode)', 'query { me { name email } }');
  const projects = await probe('projects (workspace/team token mode)', 'query { projects { edges { node { id name } } } }');
  await probe('teams', 'query { teams { edges { node { id name } } } }');

  const accountMode = me.data && me.data.me;
  const workspaceMode = projects.data && projects.data.projects;
  console.log('\n=== VERDICT ===');
  if (accountMode) console.log('Token works in ACCOUNT mode — provision will use me.projects.');
  else if (workspaceMode) console.log('Token works in WORKSPACE/TEAM mode — provision will use top-level projects.');
  else {
    console.log('Token rejected in every mode. Create a new token at railway.com → Account Settings → Tokens, choosing your PERSONAL account (no team/workspace) in the dropdown, and update the RAILWAY_TOKEN repo secret.');
    process.exit(1);
  }
}

main().catch((e) => { console.error('preflight crashed:', e.stack || e.message); process.exit(1); });
