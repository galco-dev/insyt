#!/usr/bin/env node
// One-time: mint Insyt's own Google Ads refresh token for the manager account
// (launch journey, account creation). Runs on your Mac, prints the key in
// your terminal only. Nothing is stored anywhere by this script.
//
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/manager-token.js
//
// Steps: it opens a Google sign-in page; sign in as the user that administers
// manager account 331-582-4995 and click Allow; the key is printed here.
// Then: Railway, web service, Variables, add GOOGLE_ADS_MANAGER_REFRESH_TOKEN,
// paste, save. Railway redeploys on its own.
//
// One-time setup on Google's side, if the sign-in page says
// "redirect_uri_mismatch": in Google Cloud Console, the OAuth client the app
// uses must list http://localhost:8765/callback under authorised redirect URIs.

const http = require('node:http');
const { execFile } = require('node:child_process');
const readline = require('node:readline');

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/adwords';

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || await ask('OAuth client id (from Railway, web service): ');
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || await ask('OAuth client secret: ');
  if (!clientId || !clientSecret) { console.error('Both the client id and the client secret are needed.'); process.exit(1); }

  const state = Math.random().toString(36).slice(2);
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
    const done = (text) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(text); };
    if (url.searchParams.get('state') !== state) { done('Wrong state. Run the script again.'); return finish(1, 'State mismatch; run it again.'); }
    const err = url.searchParams.get('error');
    if (err) { done(`Google said: ${err}. You can close this tab.`); return finish(1, `Google refused: ${err}`); }
    const code = url.searchParams.get('code');
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
      });
      const body = await r.json();
      if (!r.ok || !body.refresh_token) { done('No refresh token came back. You can close this tab.'); return finish(1, `Token exchange failed: ${JSON.stringify(body).slice(0, 200)}`); }
      const scopes = String(body.scope || '');
      done('Done. Your key is in the terminal. You can close this tab.');
      console.log('\nGOOGLE_ADS_MANAGER_REFRESH_TOKEN=' + body.refresh_token + '\n');
      if (!scopes.includes('adwords')) console.log('Warning: the Google Ads permission was not granted. Sign in again and tick it.');
      console.log('Next: Railway, web service, Variables, add GOOGLE_ADS_MANAGER_REFRESH_TOKEN with the value above, save.');
      console.log('Keep it like a password. To revoke it later: myaccount.google.com, Security, third-party access.');
      return finish(0);
    } catch (e) { done('Something went wrong. See the terminal.'); return finish(1, `Token exchange failed: ${e.message}`); }
  });

  function finish(code, message) {
    if (message) console.error(message);
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
  }

  server.listen(PORT, () => {
    console.log('Opening Google sign-in. Sign in as the user that administers the manager account, then click Allow.');
    console.log(`If nothing opens, paste this in a browser:\n${authUrl}\n`);
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl], () => {});
  });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
