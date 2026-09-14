// API client. Real endpoints ride the session cookie; demo mode (?demo=1,
// sticky per tab) resolves everything from canned data so every screen can be
// reviewed before Google/Stripe credentials exist.
import { demoData } from './demo.js';

const params = new URLSearchParams(window.location.search);
if (params.get('demo')) sessionStorage.setItem('insyt_demo', '1');
// The demo is a side door, never a step in the funnel. Any real entry point
// (the start page without ?demo, or a post-sign-in landing) clears the flag so
// a visitor who peeked at the sample report is never shown Glow Studio again.
else if (window.location.pathname === '/app/start' || params.has('found') || params.has('url')) sessionStorage.removeItem('insyt_demo');
export const isDemo = () => sessionStorage.getItem('insyt_demo') === '1';

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
    if (method === 'POST' && path.startsWith('/api/agency/')) { try { window.dispatchEvent(new Event('insyt:work')); } catch { /* ignore */ } }
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
  if (method === 'POST' && path.startsWith('/api/agency/')) { try { window.dispatchEvent(new Event('insyt:work')); } catch { /* ignore */ } }
  return data;
}

export const demoHref = (path) => (isDemo() ? `${path}${path.includes('?') ? '&' : '?'}demo=1` : path);

// §11 telemetry: dashboard interactions. Fire-and-forget; silent in demo
// mode and on any failure. Names are dotted lowercase (screen.view).
const sessionKey = (() => {
  try {
    let k = sessionStorage.getItem('insyt_sk');
    if (!k) { k = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('insyt_sk', k); }
    return k;
  } catch { return null; }
})();
export function track(name, props = {}) {
  if (isDemo()) return;
  try {
    const body = JSON.stringify({ name, props, session: sessionKey });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/app/event', new Blob([body], { type: 'application/json' }));
    else fetch('/api/app/event', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* telemetry never surfaces */ }
}
