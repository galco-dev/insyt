// The Plan sheet (gated-platform spec §3, §6). One component, opened from
// every locked control, over whatever screen the customer is on. It speaks in
// their numbers: the waste their report found, the fix they tapped, the $20
// already paid. After Stripe it re-opens by itself, waits for the plan to go
// active, and finishes the tapped action so the customer sees it happen.
import React, { useEffect, useRef, useState } from 'react';
import { XClose, Check, ArrowRight } from '@untitledui/icons';
import clsx from 'clsx';
import { api, isDemo, track } from './api.js';
import { useAccess, fmtMoney, setDemoLevel } from './access.jsx';
import { useRouter, Link } from './router.jsx';
import { MonoLabel, Button, Spinner } from './ui.jsx';

const TIER_LINES = {
  core: ['Every fix you approve, applied within the hour', 'Ads, tracking and counting checked every week', 'Every change watched for 48 hours, one-tap undo'],
  autopilot: ['Everything in Core', 'Routine fixes applied for you, always reversible', 'Monthly deep review, biggest money first'],
  scale: ['Everything in Autopilot', 'For accounts that spend like a job', 'Priority support, same plain register'],
};
const TIER_LABEL = { core: 'Core', autopilot: 'Autopilot', scale: 'Scale' };
const ACTIVATE_MS = 60_000;

// What can be replayed after the Stripe round trip (the closure is gone by
// then). Anything else, the customer taps again on a screen that now works.
const REPLAY = {
  approve: (id) => api(`/api/app/approve/${id}`, { method: 'POST' }),
  revert: (id) => api(`/api/app/revert/${id}`, { method: 'POST' }),
  'approve-batch': (id) => api('/api/app/approve-batch', { method: 'POST', body: { ids: String(id).split(',') } }),
  'draft.approve': (id) => api(`/api/app/drafts/${id}/approve`, { method: 'POST', body: {} }),
  'draft.enable': (id) => api(`/api/app/drafts/${id}/enable`, { method: 'POST', body: {} }),
};

function headline(access, money) {
  const price = `$${access.price_usd}/month`;
  if (access.waste_monthly_usd != null && access.waste_monthly_usd > 0) {
    const waste = money(access.waste_monthly_usd);
    // The customer's own number does the selling when it is the bigger one;
    // when it is not, the weekly check leads and the number stays honest.
    if (access.currency !== 'USD' || access.waste_monthly_usd >= access.price_usd) {
      return <>Your report found <span className="text-critical">{waste} a month</span> of waste. Core is {price}.</>;
    }
    return <>Core is {price}. Every fix you approve is applied, then checked again every week.</>;
  }
  return <>Core is {price}. Fixes are applied the moment you approve them.</>;
}

export function PlanOffer({ inline = false, initialCompare = false, upgradeTo = null }) {
  const { access, sheet, closeSheet, refresh, money, level, path, setAccess, bump } = useAccess();
  const { navigate } = useRouter();
  const [compare, setCompare] = useState(initialCompare || !!upgradeTo);
  const [cadence, setCadence] = useState('monthly');
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [state, setState] = useState(sheet && sheet.mode === 'activating' ? 'activating' : 'offer'); // offer | activating | done | slow
  const [doneTitle, setDoneTitle] = useState(null);
  const action = sheet ? sheet.action : null;
  const timer = useRef(null);

  // Return from Checkout: poll the gate until the webhook has landed, then
  // finish the tapped action. Sixty seconds, then a calm "still confirming".
  useEffect(() => {
    if (state !== 'activating') return undefined;
    const started = Date.now();
    let alive = true;
    const tick = async () => {
      const a = await refresh();
      if (!alive) return;
      if (a && a.level === 'active') {
        track('gate.activated', { seconds: Math.round((Date.now() - started) / 1000) });
        if (action && typeof action.run === 'function') {
          // Same tab, no redirect (demo): the original closure finishes the job.
          try { await action.run(); } catch { /* surfaced on the screen itself */ }
          setDoneTitle(action.title || null);
        } else if (action && action.id) {
          // Back from Stripe: replay the tapped action from what we remembered.
          const call = REPLAY[action.kind];
          if (call) { try { await call(action.id); track('gate.auto_applied', { kind: action.kind, id: action.id }); } catch { /* the webhook approved it already */ } }
          setDoneTitle(action.title || null);
        }
        setState('done');
        bump();
        return;
      }
      if (Date.now() - started > ACTIVATE_MS) { setState('slow'); return; }
      timer.current = setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!access) return <div className="p-6"><Spinner label="One moment" /></div>;

  async function subscribe(tier) {
    setBusy(tier); setNote(null);
    track('gate.checkout_start', { tier, cadence, credit: !!access.credit_applies });
    const next = path.startsWith('/app') ? path : '/app/approvals';
    try {
      const r = await api('/api/checkout/subscribe', { method: 'POST', body: { tier, cadence, next, change_id: action && action.kind === 'approve' ? action.id : null } });
      if (r.url) {
        // Remembered for the return trip (spec §6); the webhook covers approvals on its own.
        try { sessionStorage.setItem('insyt_pending_action', JSON.stringify(action ? { kind: action.kind, id: action.id, title: action.title } : null)); } catch { /* ignore */ }
        window.location.href = r.url; return;
      }
      if (isDemo()) {
        // The sample console has no Stripe: activate in place so every state can be seen.
        setDemoLevel('active');
        setAccess({ ...access, level: 'active', plan: { tier, status: 'active', label: TIER_LABEL[tier], price_usd: access.prices ? access.prices[tier] : access.price_usd }, credit_applies: false });
        setState('activating');
        return;
      }
      setNote('Payments are almost ready. Try again in a moment.');
    } catch (e) { setNote(e.message); }
    setBusy(null);
  }

  const kicker = action && action.title ? action.title : upgradeTo ? 'Autopilot' : 'Start fixing';
  const tiers = ['core', 'autopilot', 'scale'];
  const priceOf = (t) => (access.prices ? access.prices[t] : access.price_usd);
  const annual = (t) => Math.round(priceOf(t) * 10); // two months free
  const primaryTier = upgradeTo || 'core';

  const body = state === 'activating' ? (
    <div className="p-6 sm:p-8">
      <MonoLabel>Activating your plan</MonoLabel>
      <div className="mt-3 flex items-center gap-4">
        <div className="h-8 w-8 shrink-0 animate-spin rounded-full border-2 border-neutral-400 border-t-(--ui-cta-a)" aria-hidden />
        <div>
          <div className="text-h5">Stripe is confirming your card.</div>
          <p className="mt-1 text-small text-neutral-900">
            {action && action.kind === 'approve' ? 'The fix you tapped applies itself the moment this lands. Nothing else to do.' : 'This usually takes a few seconds.'}
          </p>
        </div>
      </div>
    </div>
  ) : state === 'done' ? (
    <div className="p-6 sm:p-8">
      <MonoLabel>Your plan is active</MonoLabel>
      <div className="mt-3 flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-tint text-success"><Check size={16} strokeWidth={2.6} aria-hidden /></span>
        <div>
          <div className="text-h5">{doneTitle ? `Done. ${doneTitle} is being applied.` : 'Done. Every fix you approve is applied from now on.'}</div>
          <p className="mt-1 text-small text-neutral-900">Applied within the hour, watched for 48 hours, reversible with one tap from History.</p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button onClick={() => { closeSheet(); navigate('/app/ledger'); }} className="!px-5 !py-2.5">See it in History <ArrowRight size={14} aria-hidden /></Button>
        <Button variant="secondary" onClick={closeSheet} className="!px-5 !py-2.5">Carry on</Button>
      </div>
    </div>
  ) : state === 'slow' ? (
    <div className="p-6 sm:p-8">
      <MonoLabel>Still confirming</MonoLabel>
      <div className="mt-3 text-h5">Stripe is taking longer than usual.</div>
      <p className="mt-1 text-small text-neutral-900">
        Your plan starts the moment it confirms{action && action.kind === 'approve' ? ', and the fix you tapped applies itself then' : ''}. Nothing else to do; we will email you either way.
      </p>
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" onClick={() => setState('activating')} className="!px-5 !py-2.5">Check again</Button>
        <Button variant="ghost" onClick={closeSheet}>Close</Button>
      </div>
    </div>
  ) : (
    <div className="p-6 sm:p-8">
      <MonoLabel className="block break-words pr-8">{kicker}</MonoLabel>
      <h2 className="mt-2 text-h4 tracking-tight">{upgradeTo ? <>Autopilot is ${priceOf('autopilot')}/month. It applies the routine fixes for you and tells you after.</> : headline(access, money)}</h2>
      {!compare && (
        <>
          <ul className="mt-4 flex flex-col gap-2 text-small">
            {TIER_LINES[primaryTier].map((l) => (
              <li key={l} className="flex items-start gap-2"><Check size={15} strokeWidth={2.4} className="mt-0.5 shrink-0 text-success" aria-hidden />{l}</li>
            ))}
          </ul>
          {access.credit_applies && (
            <p className="mt-4 rounded border border-neutral-300 bg-neutral-50 px-3 py-2 text-small">Your $20 audit is taken off the first month.</p>
          )}
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button onClick={() => subscribe(primaryTier)} disabled={!!busy} className="!px-6 !py-3">
              {busy ? 'Opening checkout' : `Start ${TIER_LABEL[primaryTier]}, $${priceOf(primaryTier)}/month`}
            </Button>
            <button type="button" onClick={() => { setCompare(true); track('gate.compare_open', {}); }} className="text-small underline underline-offset-2">Compare plans</button>
          </div>
        </>
      )}
      {compare && (
        <div className="mt-4">
          <div className="inline-flex rounded border border-neutral-500 bg-(--ui-well) p-0.5" role="group" aria-label="Billing period">
            {[['monthly', 'Monthly'], ['annual', 'Annual, 2 months free']].map(([value, label]) => (
              <button key={value} type="button" onClick={() => setCadence(value)} aria-pressed={cadence === value}
                className={clsx('rounded px-3 py-1.5 text-small font-medium', cadence === value ? 'bg-(--ui-cta-a) text-(--ui-cta-ink)' : 'text-neutral-900')}>
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {tiers.map((t) => {
              const current = level === 'active' && access.plan && access.plan.tier === t;
              return (
                <div key={t} className={clsx('rounded border p-4', (upgradeTo ? t === upgradeTo : t === 'core') ? 'border-(--ui-focus) ring-1 ring-(--ui-focus)' : 'border-neutral-300')}>
                  <div className="flex items-baseline justify-between">
                    <div className="text-body font-semibold">{TIER_LABEL[t]}</div>
                    <div className="text-small">{cadence === 'annual' ? <>${annual(t)}<span className="text-neutral-900">/yr</span></> : <>${priceOf(t)}<span className="text-neutral-900">/mo</span></>}</div>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1 text-tiny text-neutral-900">
                    {TIER_LINES[t].map((l) => <li key={l}>{l}</li>)}
                  </ul>
                  <div className="mt-3">
                    {current ? <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">Your plan</span>
                      : <Button variant={(upgradeTo ? t === upgradeTo : t === 'core') ? 'primary' : 'secondary'} onClick={() => subscribe(t)} disabled={!!busy} className="!px-4 !py-2 w-full">{busy === t ? 'Opening' : `Start ${TIER_LABEL[t]}`}</Button>}
                  </div>
                </div>
              );
            })}
          </div>
          {access.credit_applies && <p className="mt-3 text-small text-neutral-900">Your $20 audit is taken off the first month, whichever plan you pick.</p>}
        </div>
      )}
      {note && <p className="mt-3 text-small text-critical">{note}</p>}
      <p className="mt-5 text-tiny text-neutral-900">
        Cancel any time from Settings. Your accounts stay exactly as they are. {inline ? null : <Link to="/app/plan" className="underline underline-offset-2">Plan details</Link>}
      </p>
    </div>
  );

  return body;
}

export function PlanSheet() {
  const { sheet, closeSheet } = useAccess();
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [sheet, closeSheet]);
  if (!sheet) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Start a plan">
      <button type="button" aria-label="Close" onClick={closeSheet} className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-[560px] rounded-t-xl bg-gradient-to-b from-card-hi to-card ring-1 ring-inset ring-(--ui-ring) shadow-[0_24px_64px_-24px_rgba(0,0,0,0.6)] sm:rounded-xl">
        <button type="button" onClick={closeSheet} aria-label="Close" className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-neutral-900 hover:bg-neutral-100">
          <XClose size={16} aria-hidden />
        </button>
        <div className="max-h-[85vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <PlanOffer key={sheet.mode + (sheet.action ? sheet.action.id : '')} initialCompare={sheet.mode === 'compare'} upgradeTo={sheet.mode === 'upgrade' ? 'autopilot' : null} />
        </div>
      </div>
    </div>
  );
}
