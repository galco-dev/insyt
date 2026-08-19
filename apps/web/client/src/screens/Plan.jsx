// Funnel stage 8 — plan screen. Their band only, Core pre-selected, prices
// from pricing_config via /api/app/plan. CTA → Stripe Checkout.
import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api, isDemo } from '../lib/api.js';
import { MonoLabel, Button, Card, Spinner, ErrorNote } from '../lib/ui.jsx';

const TIER_LINES = {
  core: ['Weekly check of ads, tracking and counting', 'Every fix waits for your one-tap approval', '48-hour verification after every change'],
  autopilot: ['Everything in Core', 'Routine fixes applied for you — always reversible', 'Monthly deep review, biggest money first'],
  scale: ['Everything in Autopilot', 'For accounts that spend like a job', 'Priority support, same register'],
};

export default function Plan() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busyTier, setBusyTier] = useState(null);

  useEffect(() => { api('/api/app/plan').then((d) => setPlan(d.plan)).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!plan) return <Spinner label="Loading your plan options" />;

  async function subscribe(tier) {
    setBusyTier(tier); setNote(null);
    try {
      const r = await api('/api/checkout/subscribe', { method: 'POST', body: { tier } });
      if (r.url) { window.location.href = r.url; return; }
      setNote(isDemo() ? 'Demo mode — checkout opens here once payments are connected.' : 'Payments are almost ready — try again shortly.');
    } catch (e) { setNote(e.message); }
    setBusyTier(null);
  }

  return (
    <div className="mx-auto max-w-l2 px-5 pb-24 pt-12">
      <MonoLabel>Your $20 audit is credited to month one</MonoLabel>
      <h1 className="mt-2 text-h2 tracking-tight">Keep it fixed, every week.</h1>
      <p className="mt-2 max-w-[52ch] text-body text-neutral-900">
        The audit found the problems. A plan keeps finding them — and fixes what you approve, week after week.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {plan.tiers.map((t) => (
          <Card key={t.tier} className={t.selected ? 'border-accent p-6 ring-1 ring-accent' : 'p-6'}>
            {t.selected && <MonoLabel className="!text-accent">Recommended for you</MonoLabel>}
            <h2 className="mt-1 text-h4">{t.label}</h2>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-h3">${t.price_usd}</span>
              <span className="text-small text-neutral-900">/month</span>
            </div>
            <ul className="mt-4 flex flex-col gap-2">
              {(TIER_LINES[t.tier] || []).map((line) => (
                <li key={line} className="flex items-start gap-2 text-small text-neutral-900">
                  <Check size={14} className="mt-0.5 shrink-0 text-success" aria-hidden /> {line}
                </li>
              ))}
            </ul>
            <Button
              onClick={() => subscribe(t.tier)}
              variant={t.selected ? 'primary' : 'secondary'}
              disabled={busyTier === t.tier}
              className="mt-5 w-full"
            >
              {busyTier === t.tier ? 'Opening checkout…' : `Start ${t.label}`}
            </Button>
          </Card>
        ))}
      </div>

      {note && <div className="mt-4"><ErrorNote message={note} /></div>}
      <p className="mt-6 text-small text-neutral-900">
        Cancel anytime. Every change we ever make stays reversible, plan or no plan.
      </p>
    </div>
  );
}
