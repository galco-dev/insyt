// API client. Real endpoints ride the session cookie; demo mode (?demo=1,
// sticky per tab) resolves everything from canned data so every screen can be
// reviewed before Google/Stripe credentials exist.
import { demoData } from './demo.js';
import { buildRow, pushOnce } from './datalayer.mjs';

// Storage can throw (Edge and Safari with strict tracking prevention, private
// windows, blocked site data). Every read and write goes through these so a
// blocked store never blanks the app.
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* unavailable */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* unavailable */ } },
};
export const safeStorage = store;
const params = new URLSearchParams(window.location.search);
if (params.get('demo')) store.set('insyt_demo', '1');
// The demo is a side door, never a step in the funnel. Any real entry point
// (the start page without ?demo, or a post-sign-in landing) clears the flag so
// a visitor who peeked at the sample report is never shown Glow Studio again.
else if (window.location.pathname === '/app/start' || params.has('found') || params.has('url')) store.del('insyt_demo');
export const isDemo = () => store.get('insyt_demo') === '1';

// Landing attribution (tracking brief B2): src and trade from the marketing
// site's link, and the Google click ids, remembered for the tab so they
// survive the Google sign-in and the Stripe round trip. The click ids go to
// the server with the check and never into the dataLayer.
const ATTR_KEYS = ['src', 'trade', 'gclid', 'gbraid', 'wbraid'];
if (window.location.pathname === '/app/start') {
  for (const k of ATTR_KEYS) {
    const v = params.get(k);
    if (v && v.length <= 200) store.set(`insyt_${k}`, v);
  }
  // The profession pages send src=launch-dentists (one field); the app reads
  // it as src=launch plus trade=dentists, so both forms mean the same thing.
  const src = params.get('src') || '';
  const m = /^launch-([a-z0-9-]{2,40})$/i.exec(src);
  if (m) { store.set('insyt_src', 'launch'); if (!params.get('trade')) store.set('insyt_trade', m[1].toLowerCase()); }
}
export const attribution = () => {
  const out = {};
  for (const k of ATTR_KEYS) { const v = store.get(`insyt_${k}`); if (v) out[k] = v; }
  return out;
};

export class ApiError extends Error {
  constructor(status, message, data = {}) { super(message); this.status = status; this.data = data; }
}
// A 402 with plan_required is the gate answering (gated-platform spec §2):
// the client opens the Plan sheet instead of showing an error.
export const isPlanRequired = (e) => !!(e && e.status === 402 && e.data && e.data.plan_required);

// Every response that carries `access` updates the one AccessProvider, so a
// screen load is also a gate refresh. Registered by lib/access.jsx.
let accessListener = null;
export const onAccess = (fn) => { accessListener = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  if (isDemo()) {
    const hit = demoData(path, method, body);
    if (hit === undefined) return { ok: true };
    const out = structuredClone(hit);
    if (out && out.error && out.status) throw new ApiError(out.status, out.error, out);
    if (out && out.access && typeof accessListener === 'function') accessListener(out.access);
    if (method === 'POST' && path.startsWith('/api/')) { try { window.dispatchEvent(new Event('insyt:work')); } catch { /* ignore */ } }
    return out;
  }
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* html/redirect bodies */ }
  if (!res.ok) throw new ApiError(res.status, data.error || `request failed (${res.status})`, data);
  if (data && data.access && typeof accessListener === 'function') accessListener(data.access);
  if (method === 'POST' && path.startsWith('/api/')) { try { window.dispatchEvent(new Event('insyt:work')); } catch { /* ignore */ } }
  return data;
}

export const demoHref = (path) => (isDemo() && !/[?&]demo=1(&|$)/.test(path) ? `${path}${path.includes('?') ? '&' : '?'}demo=1` : path);

// §11 telemetry: dashboard interactions. Fire-and-forget; silent in demo
// mode and on any failure. Names are dotted lowercase (screen.view).
const sessionKey = (() => {
  try {
    let k = store.get('insyt_sk');
    if (!k) { k = Math.random().toString(36).slice(2, 12); store.set('insyt_sk', k); }
    return k;
  } catch { return null; }
})();
// Tag Manager dataLayer (tracking brief B2): rows come from lib/datalayer.mjs
// (pure, tested); this wires them to the tab's attribution, the signed-in
// tenant id and window.dataLayer. Inert in demo mode, silent on failure.
export function setDataLayerUser(id) { if (id) store.set('insyt_uid', String(id)); }
export function pushDL(event, extra = {}) {
  try {
    const row = buildRow(event, extra, { demo: isDemo(), attribution: attribution(), userId: store.get('insyt_uid') });
    if (!row) return false;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(row);
    return true;
  } catch { return false; }
}
// One push per transaction id, kept for the tab so a reload never repeats it.
export const pushDLOnce = (key, event, extra = {}) => pushOnce(store, key, () => pushDL(event, extra));

export function track(name, props = {}) {
  if (isDemo()) return;
  try {
    const body = JSON.stringify({ name, props, session: sessionKey });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/app/event', new Blob([body], { type: 'application/json' }));
    else fetch('/api/app/event', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* telemetry never surfaces */ }
}
