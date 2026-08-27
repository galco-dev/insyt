// Settings - §11. Plan, connection, autopilot categories, billing portal,
// and the your-data actions the legal pages promise (export, delete,
// disconnect). Autopilot toggles write through /api/app/autopilot.
import React, { useEffect, useState } from 'react';
import { CreditCard01 as CreditCard, Link01 as Link2, Zap, ShieldTick as ShieldCheck, Lock01 as Lock } from '@untitledui/icons';
import clsx from 'clsx';
import { api, isDemo } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { MonoLabel, Card, Spinner, Button, ErrorNote } from '../lib/ui.jsx';

const AUTOPILOT_LABEL = {
  negatives: 'Excluding money-wasting searches',
  budgets: 'Small budget moves between your campaigns',
  counting: 'Keeping your counting honest',
};

function Toggle({ on, busy, onClick, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className={clsx(
        'relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150',
        on ? 'border-transparent bg-(--ui-cta-a)' : 'border-neutral-400 bg-neutral-200',
        busy && 'opacity-60',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all duration-150',
          on ? 'left-[22px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

// §4.5 standing exceptions: what the owner has told us never to touch.
function Exceptions() {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => { api('/api/app/exceptions').then((d) => setItems(d.exceptions || [])).catch(() => setItems([])); }, []);
  if (!items || !items.length) return null;
  async function clear(id) {
    setBusy(id);
    try { await api(`/api/app/exceptions/${id}/clear`, { method: 'POST' }); setItems((xs) => xs.filter((x) => x.id !== id)); } catch { /* stays listed */ }
    setBusy(null);
  }
  return (
    <Card className="mt-3 p-5">
      <div className="flex items-start gap-3">
        <Lock size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
        <div className="flex-1">
          <MonoLabel>Never touch</MonoLabel>
          <p className="mt-0.5 text-small text-neutral-900">
            Changes you undid. Autopilot will not re-apply these on its own; if the numbers change we may ask you again, and say why.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {items.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 text-small">
                <span>{x.summary_text}</span>
                <Button variant="secondary" onClick={() => clear(x.id)} disabled={busy === x.id} className="!px-3 !py-1.5">Allow again</Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [recheck, setRecheck] = useState(null);
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

  async function flip(key) {
    const next = { ...autopilot, [key]: !autopilot[key] };
    setBusyKey(key);
    // Optimistic: the switch answers immediately; a failure rolls it back.
    setSettings((s) => ({ ...s, autopilot: next }));
    try {
      await api('/api/app/autopilot', { method: 'POST', body: { categories: next } });
    } catch (e) {
      setSettings((s) => ({ ...s, autopilot }));
      setNote(e.message);
    }
    setBusyKey(null);
  }

  const mail = (subject) => `mailto:hello@tryinsyt.com?subject=${encodeURIComponent(subject)}`;

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
          <div className="flex shrink-0 gap-2">
            <Link to="/app/plan"><Button variant="secondary" className="!px-4 !py-2">Change plan</Button></Link>
            <Button variant="secondary" onClick={portal} className="!px-4 !py-2">Manage card</Button>
          </div>
        </div>
        <p className="mt-3 text-tiny text-neutral-900">
          Cancelling? The card page handles it - your subscription runs to the end of the period you paid for, and your accounts stay exactly as they are.
        </p>
      </Card>

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <Link2 size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Google connection</MonoLabel>
            <div className="mt-0.5 text-body">{settings.connection_status}</div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="secondary" disabled={recheck === 'busy'} onClick={async () => {
                setRecheck('busy');
                try { const r = await api('/api/app/recheck', { method: 'POST' }); setRecheck(r.note || 'On its way - your report refreshes in about ten minutes.'); }
                catch (e) { setRecheck(e.message); }
              }}>Check again now</Button>
              {recheck && recheck !== 'busy' && <span className="text-tiny text-neutral-900">{recheck}</span>}
            </div>
            <p className="mt-2 text-tiny text-neutral-900">
              To cut off our access at any time, remove Insyt at{' '}
              <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer" className="underline underline-offset-2">your Google Account</a>
              {' '}or <a href={mail('Disconnect my Google account')} className="underline underline-offset-2">email us</a> and we do it for you. Stored data is deleted within 30 days.
            </p>
          </div>
        </div>
      </Card>

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <Zap size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Autopilot</MonoLabel>
            <p className="mt-0.5 text-small text-neutral-900">
              What we may fix without waiting for a tap. Everything stays reversible and lands in your history.
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              {Object.entries(AUTOPILOT_LABEL).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-small">
                  <span>{label}</span>
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">
                      {autopilot[key] ? 'On' : 'Asks first'}
                    </span>
                    <Toggle on={!!autopilot[key]} busy={busyKey === key} onClick={() => flip(key)} label={label} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Exceptions />

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Your data</MonoLabel>
            <p className="mt-0.5 text-small text-neutral-900">
              Everything we hold is yours. Export it or delete it whenever you like - requests are completed within 30 days.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" href={mail('Data export')} className="!px-4 !py-2">Export my data</Button>
              <Button variant="secondary" href={mail('Delete my data')} className="!px-4 !py-2">Delete my account</Button>
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
