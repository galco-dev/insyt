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
