// The gate on the client (gated-platform spec §1, §3, §6).
//
// One AccessProvider holds the tenant's access level and the numbers that
// come with it. Every API response that carries `access` refreshes it, so a
// screen load is also a gate refresh. Screens call gate() around any write:
//   active   → the write runs
//   unlocked → the Plan sheet opens with the tapped action pending
//   locked   → the customer is sent to the unlock (see first, then act)
// A 402 plan_required from the server does the same, so nothing depends on a
// button being hidden. The return from Stripe (?subscribed=1&pa=<change>)
// re-opens the sheet in its activating state and finishes the tapped action.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onAccess, isPlanRequired, isDemo, track, pushDL, pushDLOnce, setDataLayerUser } from './api.js';

// Tracking brief B4: the payment events fire only once the server has the
// record (the webhook may land a few seconds after Stripe sends us back), and
// once per Stripe id, kept for the tab. The list price is the value; the
// amount actually paid rides alongside, with internal_test when it was $0.
async function pushPaymentEvent(kind) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 12; i += 1) {
    let d = null;
    try { d = await api('/api/app/last-payment'); } catch { d = null; }
    const p = d && d.payment;
    const s = d && d.subscription;
    if (kind === 'paid' && p && p.transaction_id) {
      const bundle = p.kind === 'setup_bundle';
      pushDLOnce(p.transaction_id, bundle ? 'launch_bundle_purchased' : 'report_unlocked', {
        transaction_id: p.transaction_id, value: bundle ? 199 : p.value_usd, currency: 'USD', ...(bundle ? {} : { item: p.kind }),
        amount_paid: p.amount_paid_usd, ...(p.internal_test ? { internal_test: true } : {}),
      });
      return;
    }
    if (kind === 'subscribed' && s && s.transaction_id && /active|trialing/.test(s.status || '')) {
      let cadence = null;
      try { cadence = sessionStorage.getItem('insyt_cadence'); } catch { cadence = null; }
      pushDLOnce(s.transaction_id, 'subscription_started', {
        transaction_id: s.transaction_id, value: s.value_usd, currency: 'USD', plan: s.plan, cadence: cadence || 'monthly',
        amount_paid: s.amount_paid_usd == null ? s.value_usd : s.amount_paid_usd, ...(s.internal_test ? { internal_test: true } : {}),
      });
      return;
    }
    await wait(5000);
  }
}
import { useRouter } from './router.jsx';

const AccessCtx = createContext(null);

export const LEVELS = { locked: 'locked', unlocked: 'unlocked', active: 'active' };

// Money in the account's currency; USD keeps the $ sign.
const SYMBOL = { USD: '$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$', NZD: 'NZ$' };
export function fmtMoney(n, code = 'USD') {
  const c = String(code || 'USD').toUpperCase();
  const v = Math.round(Number(n || 0)).toLocaleString('en-US');
  return SYMBOL[c] ? `${SYMBOL[c]}${v}` : `${c} ${v}`;
}

export function AccessProvider({ children }) {
  const [access, setAccessState] = useState(null);
  const [sheet, setSheet] = useState(null); // null | { mode, action, title }
  // Bumped when a plan activates and finishes an action, so open screens reload their lists.
  const [version, setVersion] = useState(0);
  const [paidNow, setPaidNow] = useState(false); // back from the $20 checkout this visit: the report answers back
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const { path, navigate } = useRouter();
  const pendingRef = useRef(null);

  const setAccess = useCallback((a) => { if (a) { setAccessState(a); setDataLayerUser(a.tenant_id); } }, []);
  useEffect(() => { onAccess(setAccess); return () => onAccess(null); }, [setAccess]);

  const refresh = useCallback(async () => {
    try { const d = await api('/api/app/access'); if (d && d.access) setAccessState(d.access); return d && d.access; } catch { return null; }
  }, []);

  const level = access ? access.level : null;

  const openSheet = useCallback((opts = {}) => {
    track('gate.sheet_open', { kind: opts.action ? opts.action.kind : 'compare', level });
    setSheet({ mode: opts.mode || 'offer', action: opts.action || null, title: opts.title || null });
  }, [level]);
  const closeSheet = useCallback(() => { track('gate.dismissed', {}); setSheet(null); }, []);

  // Where the customer goes to pay the $20: the latest report's unlock bar.
  const goUnlock = useCallback(() => {
    track('gate.shown', { control: 'unlock', level });
    api('/api/app/reports').then((d) => {
      const r = d && d.reports && d.reports[0];
      navigate(r ? `/app/report/${r.id}?unlock=1` : '/app');
    }).catch(() => navigate('/app'));
  }, [navigate, level]);

  /**
   * gate(run, action): run the write at active; otherwise open what the level
   * needs. `action` = { kind, id, title, run } and is what the sheet finishes
   * after the plan activates. Returns true when the write ran now.
   */
  const gate = useCallback(async (run, action) => {
    let lvl = level;
    // Undo stays free for 30 days after cancelling (fix plan move 13).
    const undoFree = action && action.kind === 'revert' && access && access.undo_until && Date.parse(access.undo_until) > Date.now();
    if (lvl === 'active' || !lvl || undoFree) {
      try { await run(); return true; } catch (e) {
        if (!isPlanRequired(e)) throw e;
        // The server knows better than a stale client: fall through to the sheet.
        const fresh = await refresh();
        lvl = fresh ? fresh.level : 'unlocked';
      }
    }
    track('gate.shown', { control: action ? action.kind : 'write', level: lvl });
    if (lvl === 'locked') { goUnlock(); return false; }
    pendingRef.current = action ? { ...action, run } : null;
    openSheet({ action: action ? { ...action, run } : null });
    return false;
  }, [level, refresh, goUnlock, openSheet]);

  // Return from Checkout (spec §6): re-open the sheet, wait for the webhook,
  // then finish the tapped action. The URL is cleaned so a reload is inert.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Google sign-in lands on the confirm step with what discovery found (tracking brief B3).
    if (window.location.pathname === '/app/confirm' && params.has('found')) pushDLOnce('signin', 'signin', { method: 'google' });
    if (params.get('subscribed') === '1') {
      const pa = params.get('pa');
      params.delete('subscribed'); params.delete('pa');
      const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
      window.history.replaceState({}, '', clean);
      let remembered = null;
      try { remembered = JSON.parse(sessionStorage.getItem('insyt_pending_action') || 'null'); sessionStorage.removeItem('insyt_pending_action'); } catch { /* ignore */ }
      const action = remembered && remembered.id ? remembered : pa ? { kind: 'approve', id: pa, title: null } : null;
      setSheet({ mode: 'activating', action, title: null });
      if (!isDemo()) pushPaymentEvent('subscribed');
    } else if (params.get('paid') === '1') {
      setPaidNow(true);
      if (!isDemo()) pushPaymentEvent('paid');
      params.delete('paid');
      window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => ({
    access, level, setAccess, refresh, gate, openSheet, closeSheet, sheet, goUnlock, path, version, bump, paidNow,
    money: (n) => fmtMoney(n, access ? access.currency : 'USD'),
    pendingAction: () => pendingRef.current,
  }), [access, level, setAccess, refresh, gate, openSheet, closeSheet, sheet, goUnlock, path, version, bump, paidNow]);

  return <AccessCtx.Provider value={value}>{children}</AccessCtx.Provider>;
}

export function useAccess() {
  const v = useContext(AccessCtx);
  if (!v) throw new Error('useAccess outside AccessProvider');
  return v;
}

// Demo-only: the sample console can preview any level (?demo=1&access=unlocked).
export const demoLevel = () => {
  try { return sessionStorage.getItem('insyt_demo_access') || 'active'; } catch { return 'active'; }
};
export const setDemoLevel = (lvl) => { try { sessionStorage.setItem('insyt_demo_access', lvl); } catch { /* ignore */ } };
export const inDemo = isDemo;
