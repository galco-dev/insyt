#!/usr/bin/env node
// Railway preflight — verbose diagnostics for the provision workflow.
// Prints exactly what is wrong: missing secret, bad token, or schema drift.
// Never prints the token itself.

const API = 'https://backboard.railway.com/graphql/v2';

async function main() {
  const token = process.env.RAILWAY_TOKEN;
  console.log(`RAILWAY_TOKEN present: ${!!token}${token ? ` (length ${token.length}, starts ${token.slice(0, 4)}…)` : ''}`);
  if (!token) {
    console.error('FAIL: the RAILWAY_TOKEN repo secret is not reaching the job. Check the secret name is exactly RAILWAY_TOKEN at Settings → Secrets and variables → Actions.');
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
    console.log(`HTTP ${res.status}`);
    console.log(text.slice(0, 1500));
    return { status: res.status, text };
  };

  const me = await probe('me query', 'query { me { name email } }');
  if (me.status === 401 || /Not Authorized/i.test(me.text)) {
    console.error('\nFAIL: Railway rejected the token. Account tokens are created at railway.com → Account Settings → Tokens. If this token was created under a TEAM, it may need a different scope — create a personal account token (no team selected) and update the repo secret.');
    process.exit(1);
  }

  await probe('projects via me', 'query { me { projects { edges { node { id name } } } } }');
  await probe('projects top-level (schema alternative)', 'query { projects { edges { node { id name } } } }');
  console.log('\nPreflight complete — paste this whole log to Claude.');
}

main().catch((e) => { console.error('preflight crashed:', e.stack || e.message); process.exit(1); });
