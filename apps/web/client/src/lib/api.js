// API client. Real endpoints ride the session cookie; demo mode (?demo=1,
// sticky per tab) resolves everything from canned data so every screen can be
// reviewed before Google/Stripe credentials exist.
import { demoData } from './demo.js';

const params = new URLSearchParams(window.location.search);
if (params.get('demo')) sessionStorage.setItem('insyt_demo', '1');
export const isDemo = () => sessionStorage.getItem('insyt_demo') === '1';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body } = {}) {
  if (isDemo()) {
    const hit = demoData(path, method, body);
    if (hit !== undefined) return structuredClone(hit);
    return { ok: true };
  }
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* html/redirect bodies */ }
  if (!res.ok) throw new ApiError(res.status, data.error || `request failed (${res.status})`);
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
