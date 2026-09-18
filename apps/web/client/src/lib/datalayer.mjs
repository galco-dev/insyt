// Tag Manager dataLayer rows (tracking brief, 18 Sep 2026). Pure: no window,
// no storage, so node:test can cover it. api.js wires it to sessionStorage
// and window.dataLayer.
//
//   buildRow(event, extra, { demo, attribution, userId }) -> row | null
//   journeyOf(attribution) -> 'A' | 'B'
//   pushOnce(store, key, push) -> boolean   (one push per transaction id)
//
// Never an email, a name, an owner's identity or a Google account id: any
// string carrying "@" is dropped, and only whitelisted shared fields ride.

const PII_RE = /@/;

export function journeyOf(attribution) {
  return attribution && attribution.src === 'launch' ? 'B' : 'A';
}

export function buildRow(event, extra = {}, { demo = false, attribution = {}, userId = null } = {}) {
  if (demo || !event) return null;
  const a = attribution || {};
  const row = { event: String(event), journey: journeyOf(a) };
  if (a.src && !PII_RE.test(String(a.src))) row.src = String(a.src).slice(0, 60);
  if (a.trade && !PII_RE.test(String(a.trade))) row.trade = String(a.trade).slice(0, 60);
  if (userId) row.user_id = String(userId);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && PII_RE.test(v)) continue;
    if (typeof v === 'object') continue;
    row[k] = v;
  }
  return row;
}

// store: { get(key), set(key, value) } that may throw; a stored key means pushed.
export function pushOnce(store, key, push) {
  const k = `insyt_dl_${key}`;
  try { if (store.get(k)) return false; } catch { /* no store: push anyway, once per load */ }
  const ok = push();
  if (ok) { try { store.set(k, '1'); } catch { /* fine */ } }
  return !!ok;
}
