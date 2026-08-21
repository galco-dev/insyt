// Settings - §11. Plan, connection, autopilot categories, billing portal.
import React, { useEffect, useState } from 'react';
import { CreditCard01 as CreditCard, Link01 as Link2, Zap } from '@untitledui/icons';
import { api, isDemo } from '../lib/api.js';
import { MonoLabel, Card, Spinner, Button, ErrorNote } from '../lib/ui.jsx';

const AUTOPILOT_LABEL = {
  negatives: 'Excluding money-wasting searches',
  budgets: 'Small budget moves between your campaigns',
  counting: 'Keeping your counting honest',
};

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  useEffect(() => { api('/api/app/settings').then((d) => setSettings(d.settings)).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!settings) return <Spinner label="Loading settings" />;

  async function portal() {
    setNote(null);
    try {
      const r = await api('/api/checkout/portal', { method: 'POST' });
      if (r.url) { window.location.href = r.url; return; }
      setNote(isDemo() ? 'Demo mode - the card page opens here once payments are connected.' : 'Billing portal is almost ready - try again shortly.');
    } catch (e) { setNote(e.message); }
  }

  const autopilot = settings.autopilot || {};

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Your account</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Settings</h1>

      <Card className="mt-6 p-5">
        <div className="flex items-start gap-3">
          <CreditCard size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Plan</MonoLabel>
            <div className="mt-0.5 text-body font-medium">{settings.plan_line}</div>
          </div>
          <Button variant="secondary" onClick={portal} className="!px-4 !py-2">Manage card</Button>
        </div>
      </Card>

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <Link2 size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div>
            <MonoLabel>Google connection</MonoLabel>
            <div className="mt-0.5 text-body">{settings.connection_status}</div>
          </div>
        </div>
      </Card>

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <Zap size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Autopilot</MonoLabel>
            <p className="mt-0.5 text-small text-neutral-900">
              What we may fix without waiting for a tap. Everything stays reversible and lands in your ledger.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {Object.entries(AUTOPILOT_LABEL).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-small">
                  <span>{label}</span>
                  <span className={autopilot[key] ? 'font-mono text-tiny uppercase tracking-[0.1em] text-success' : 'font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900'}>
                    {autopilot[key] ? 'On' : 'Asks first'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {note && <div className="mt-4"><ErrorNote message={note} /></div>}

      <p className="mt-6 text-tiny text-neutral-900">
        Weekly report emails can be paused from any report email - alerts about breakage always reach you, those protect your money.
      </p>
    </div>
  );
}
