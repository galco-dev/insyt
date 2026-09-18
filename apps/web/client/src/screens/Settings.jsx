// Settings - §11. Plan, connection, autopilot categories, billing portal,
// and the your-data actions the legal pages promise (export, delete,
// disconnect). Autopilot toggles write through /api/app/autopilot.
import React, { useEffect, useState } from 'react';
import { CreditCard01 as CreditCard, Link01 as Link2, Zap, ShieldTick as ShieldCheck, Lock01 as Lock, LogOut01 as LogOut, Calendar as CalendarIcon, Mail01 as MailIcon, Building02 as Building } from '@untitledui/icons';
import clsx from 'clsx';
import { api, isDemo } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { useAccess } from '../lib/access.jsx';
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

const RUN_LABEL = { signup_audit: 'Your audit', weekly: 'Weekly check', deep: 'Deep review', triggered: 'Extra check', verification: 'Verification' };
const RUN_STATUS = { complete: 'done', degraded: 'done, partly', failed: 'did not finish', running: 'running now', queued: 'queued' };
const BAND_LINE = { '4k': 'around 4,000 search terms a month', '10k': 'around 10,000 search terms a month', '25k': 'around 25,000 search terms a month' };
const longDate = (iso) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// Weekly check card (richer-platform spec §6): the schedule, the next run,
// Check again now, and the last three runs with their status.
function WeeklyCheck({ weekly }) {
  const [recheck, setRecheck] = useState(null);
  if (!weekly) return null;
  const tz = weekly.timezone ? weekly.timezone.replace(/_/g, ' ') : null;
  return (
    <Card className="mt-3 p-5">
      <div className="flex items-start gap-3">
        <CalendarIcon size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
        <div className="flex-1">
          <MonoLabel>Weekly check</MonoLabel>
          <div className="mt-0.5 text-body">
            Every Sunday night{tz ? `, ${tz} time` : ''}. Next one {weekly.next_run_at ? longDate(weekly.next_run_at) : 'this Sunday'}.
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={recheck === 'busy'} className="!px-4 !py-2" onClick={async () => {
              setRecheck('busy');
              try { const r = await api('/api/app/recheck', { method: 'POST' }); setRecheck(r.note || 'On its way - your report refreshes in about ten minutes.'); }
              catch (e) { setRecheck(e.message); }
            }}>Check again now</Button>
            {recheck && recheck !== 'busy' && <span className="text-tiny text-neutral-900">{recheck}</span>}
          </div>
          {weekly.last_runs && weekly.last_runs.length > 0 && (
            <ul className="mt-3 divide-y divide-neutral-200 rounded border border-neutral-300 bg-neutral-50">
              {weekly.last_runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-small">
                  <span>{RUN_LABEL[r.type] || r.type}<span className="text-neutral-900">, {RUN_STATUS[r.status] || r.status}</span></span>
                  <span className="font-mono text-tiny text-neutral-900">{r.finished_at ? shortDate(r.finished_at) : r.started_at ? shortDate(r.started_at) : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

// Emails card (spec §6): weekly report on or off, alerts always on, and the
// address everything goes to.
function Emails({ emails, onChange }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (!emails) return null;
  async function flip() {
    setBusy(true); setNote(null);
    try { const r = await api('/api/app/emails', { method: 'POST', body: { reports: !emails.reports } }); onChange({ ...emails, reports: !!r.reports }); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  }
  return (
    <Card className="mt-3 p-5">
      <div className="flex items-start gap-3">
        <MailIcon size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
        <div className="flex-1">
          <MonoLabel>Emails</MonoLabel>
          <p className="mt-0.5 text-small text-neutral-900">{emails.address ? `Everything goes to ${emails.address}.` : 'Sent to the address on your Google account.'}</p>
          <div className="mt-3 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3 text-small">
              <span>Weekly report</span>
              <div className="flex items-center gap-2.5">
                <span className="whitespace-nowrap font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">{emails.reports ? 'On' : 'Off'}</span>
                <Toggle on={!!emails.reports} busy={busy} onClick={flip} label="Weekly report emails" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-small">
              <span>Alerts about breakage</span>
              <span className="whitespace-nowrap font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">Always on</span>
            </div>
          </div>
          <p className="mt-2 text-tiny text-neutral-900">Alerts protect your money, so they always reach you.</p>
          {note && <p className="mt-2 text-tiny text-critical">{note}</p>}
        </div>
      </div>
    </Card>
  );
}

// Business card (spec §6): name and website feed the report header; the
// currency and the size band explain the numbers you see.
function Business({ business, money, onSaved }) {
  const [name, setName] = useState((business && business.name) || '');
  const [website, setWebsite] = useState((business && business.website) || '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (!business) return null;
  const dirty = name !== (business.name || '') || website !== (business.website || '');
  async function save() {
    setBusy(true); setNote(null);
    try { const r = await api('/api/app/business', { method: 'POST', body: { name, website } }); onSaved({ ...business, name: r.business_name ?? name, website: r.website_url ?? website }); setNote('Saved.'); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  }
  const field = 'w-full rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)';
  return (
    <Card className="mt-3 p-5">
      <div className="flex items-start gap-3">
        <Building size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
        <div className="flex-1">
          <MonoLabel>Your business</MonoLabel>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-tiny text-neutral-900">Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} mt-1`} placeholder="Your business name" maxLength={120} />
            </label>
            <label className="text-tiny text-neutral-900">Website
              <input value={website} onChange={(e) => setWebsite(e.target.value)} className={`${field} mt-1`} placeholder="yourwebsite.com" inputMode="url" autoCapitalize="none" maxLength={200} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={save} disabled={busy || !dirty} className="!px-4 !py-2">{busy ? 'Saving…' : 'Save'}</Button>
            {note && <span className="text-tiny text-neutral-900">{note}</span>}
          </div>
          <p className="mt-3 text-tiny text-neutral-900">
            Money shows in {business.currency || 'USD'}{money ? `, like ${money(1250)}` : ''}. Your plan is sized for {BAND_LINE[business.band] || BAND_LINE['4k']}, which sets the price you see.
          </p>
        </div>
      </div>
    </Card>
  );
}

// Look again for accounts (fix plan move 10): a new ads account or a rebuilt
// analytics setup shows up here, then on Confirm to choose.
function LookAgain() {
  const [state, setState] = useState('idle'); // idle | busy | done | error
  const [msg, setMsg] = useState(null);
  async function go() {
    setState('busy'); setMsg(null);
    try {
      const r = await api('/api/app/rediscover', { method: 'POST' });
      const fresh = r.fresh_unmatched || [];
      setMsg(r.inserted === 0 ? 'Nothing new. Everything your Google account can see is already here.' : fresh.length ? `Found ${r.inserted} new. ${fresh.length} did not match your site; choose on the confirm page.` : `Found ${r.inserted} new and matched to your site.`);
      setState('done');
    } catch (e) { setMsg(e.message); setState('error'); }
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button variant="secondary" onClick={go} disabled={state === 'busy'} className="!px-4 !py-2">{state === 'busy' ? 'Looking…' : 'Look again for accounts'}</Button>
      {msg && <span className="text-tiny text-neutral-900">{msg}{state === 'done' && /choose/.test(msg) ? <> <Link to="/app/confirm" className="underline underline-offset-2">Choose now</Link></> : null}</span>}
    </div>
  );
}

// People and businesses (fix plan move 12): invite a viewer, open another
// business you own, add one. A viewer sees a single line instead.
function People({ access }) {
  const [email, setEmail] = useState('');
  const [site, setSite] = useState('');
  const [businesses, setBusinesses] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  useEffect(() => { api('/api/app/businesses').then((d) => setBusinesses(d.businesses || [])).catch(() => setBusinesses([])); }, []);
  if (access && access.role === 'viewer') return <p className="mt-3 text-small text-neutral-900">You are viewing this account. Approvals stay with the owner.</p>;
  async function invite() {
    setBusy('invite'); setNote(null);
    try { await api('/api/app/invite', { method: 'POST', body: { email } }); setNote(`Invited ${email}. They can see everything; approvals stay yours.`); setEmail(''); }
    catch (e) { setNote(e.message); }
    setBusy(null);
  }
  async function open(id) {
    setBusy(id);
    try { await api('/api/app/switch-tenant', { method: 'POST', body: { tenant_id: id } }); window.location.href = '/app'; }
    catch (e) { setNote(e.message); setBusy(null); }
  }
  async function add() {
    setBusy('add'); setNote(null);
    try { await api('/api/app/add-business', { method: 'POST', body: { website: site } }); window.location.href = '/app/confirm'; }
    catch (e) { setNote(e.message); setBusy(null); }
  }
  const field = 'w-full rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)';
  return (
    <div className="mt-4 border-t border-neutral-200 pt-4">
      <MonoLabel>Who can see this</MonoLabel>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoCapitalize="none" placeholder="Invite someone to see this, by email" aria-label="Invite someone to see this" className={field} />
        <Button variant="secondary" onClick={invite} disabled={busy === 'invite' || !email.includes('@')} className="shrink-0 !px-4 !py-2">Invite to view</Button>
      </div>
      <p className="mt-1 text-tiny text-neutral-900">They see everything you see. Approving stays with you.</p>
      {businesses && businesses.length > 1 && (
        <div className="mt-4">
          <MonoLabel>Your businesses</MonoLabel>
          <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-300 bg-neutral-50">
            {businesses.map((b) => (
              <li key={b.tenant_id} className="flex items-center justify-between gap-3 px-3 py-2 text-small">
                <span className="min-w-0 truncate">{b.name}{b.website && b.website !== b.name ? <span className="ml-2 text-tiny text-neutral-900">{b.website}</span> : null}</span>
                {b.current ? <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">this one</span> : <Button variant="secondary" onClick={() => open(b.tenant_id)} disabled={busy === b.tenant_id} className="!px-3 !py-1.5">Open</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <MonoLabel>Another business?</MonoLabel>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={site} onChange={(e) => setSite(e.target.value)} inputMode="url" autoCapitalize="none" placeholder="itswebsite.com" aria-label="Website of the other business" className={field} />
          <Button variant="secondary" onClick={add} disabled={busy === 'add' || !site.includes('.')} className="shrink-0 !px-4 !py-2">Add it</Button>
        </div>
        <p className="mt-1 text-tiny text-neutral-900">Same Google sign-in, its own account and report. No second consent screen.</p>
      </div>
      {note && <p className="mt-2 text-tiny text-neutral-900">{note}</p>}
    </div>
  );
}

// Pause everything until a date (fix plan move 13).
function Pause({ access, onChange }) {
  const [until, setUntil] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const paused = access && access.paused_until;
  async function pause() {
    setBusy(true); setNote(null);
    try { const r = await api('/api/app/pause', { method: 'POST', body: { until: `${until}T00:00:00Z` } }); onChange(r.paused_until); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  }
  async function resume() {
    setBusy(true); setNote(null);
    try { await api('/api/app/resume', { method: 'POST' }); onChange(null); } catch (e) { setNote(e.message); }
    setBusy(false);
  }
  return (
    <div className="mt-3 border-t border-neutral-200 pt-3">
      {paused ? (
        <div className="flex flex-wrap items-center gap-3 text-small">
          <span>Paused until {new Date(paused).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}. Nothing runs and nothing is billed until then; alerts about breakage still reach you.</span>
          <Button variant="secondary" onClick={resume} disabled={busy} className="!px-4 !py-2">Resume now</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-small">
          <span>Going quiet for a while?</span>
          <label className="flex items-center gap-2 text-tiny text-neutral-900">Pause until
            <input type="date" value={until} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} max={new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} className="rounded border border-neutral-500 bg-(--ui-well) px-2 py-1 text-small outline-none focus:border-(--ui-focus)" />
          </label>
          <Button variant="secondary" onClick={pause} disabled={busy} className="!px-4 !py-2">Pause</Button>
        </div>
      )}
      {note && <p className="mt-2 text-tiny text-critical">{note}</p>}
    </div>
  );
}

// §4.5 standing exceptions: what the owner has told us never to touch.
function Exceptions() {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState(null);
  const [note, setNote] = useState(null);
  const load = () => api('/api/app/exceptions').then((d) => setItems(d.exceptions || [])).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  if (!items) return null;
  async function clear(id) {
    setBusy(id);
    try { await api(`/api/app/exceptions/${id}/clear`, { method: 'POST' }); setItems((xs) => xs.filter((x) => x.id !== id)); } catch { /* stays listed */ }
    setBusy(null);
  }
  // Add (fix plan move 7): the campaigns we last saw, one tap each.
  async function openAdd() {
    setAdding(true); setNote(null);
    try { const d = await api('/api/app/fence-options'); setOptions(d.options || []); } catch (e) { setNote(e.message); setOptions([]); }
  }
  async function fence(o) {
    setBusy(o.target);
    try {
      await api('/api/app/exceptions', { method: 'POST', body: { target: o.target, summary_text: `Leave "${o.name}" alone` } });
      setOptions((xs) => xs.map((x) => (x.target === o.target ? { ...x, fenced: true } : x)));
      await load();
    } catch (e) { setNote(e.message); }
    setBusy(null);
  }
  return (
    <Card className="mt-3 p-5">
      <div className="flex items-start gap-3">
        <Lock size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
        <div className="flex-1">
          <MonoLabel>Never touch</MonoLabel>
          <p className="mt-0.5 text-small text-neutral-900">
            {items.length ? 'What you told us to leave alone. Autopilot never touches these; if the numbers change we may ask you again, and say why.' : 'Nothing fenced off. Anything here is never touched, not even on Autopilot.'}
          </p>
          {items.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {items.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 text-small">
                  <span>{x.summary_text}</span>
                  <Button variant="secondary" onClick={() => clear(x.id)} disabled={busy === x.id} className="!px-3 !py-1.5">Allow again</Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            {!adding && <Button variant="secondary" onClick={openAdd} className="!px-4 !py-2">Add a campaign to leave alone</Button>}
            {adding && options === null && <span className="text-tiny text-neutral-900">Looking up your campaigns…</span>}
            {adding && options && options.length === 0 && <span className="text-tiny text-neutral-900">We have not read your campaigns yet. They appear here after the first check.</span>}
            {adding && options && options.length > 0 && (
              <ul className="divide-y divide-neutral-200 rounded border border-neutral-300 bg-neutral-50">
                {options.map((o) => (
                  <li key={o.target} className="flex items-center justify-between gap-3 px-3 py-2 text-small">
                    <span className="min-w-0 truncate">{o.name}{o.status && o.status !== 'enabled' ? <span className="ml-2 text-tiny text-neutral-900">{o.status}</span> : null}</span>
                    {o.fenced
                      ? <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">left alone</span>
                      : <Button variant="secondary" onClick={() => fence(o)} disabled={busy === o.target} className="!px-3 !py-1.5">Leave alone</Button>}
                  </li>
                ))}
              </ul>
            )}
            {note && <p className="mt-2 text-tiny text-critical">{note}</p>}
          </div>
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
  const { access, level, gate, openSheet, goUnlock, money, setAccess } = useAccess();
  useEffect(() => {
    api('/api/app/settings').then((d) => {
      setSettings(d.settings);
      // First visit: remember the browser's timezone so the weekly check card
      // can speak in the customer's own time (spec §6).
      const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();
      if (tz && d.settings && d.settings.weekly && !d.settings.weekly.timezone) {
        api('/api/app/business', { method: 'POST', body: { timezone: tz } })
          .then(() => setSettings((s) => (s && s.weekly ? { ...s, weekly: { ...s.weekly, timezone: tz } } : s)))
          .catch(() => {});
      }
    }).catch((e) => setError(e.message));
  }, []);

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

  // Autopilot is a plan feature (gated-platform spec §4, Settings): without a
  // plan a tap opens the Plan sheet; on Core it opens the Autopilot upgrade.
  const onAutopilotPlan = level === 'active' && access && access.plan && (access.plan.tier === 'autopilot' || access.plan.tier === 'scale');
  async function flip(key) {
    if (level === 'active' && access && !onAutopilotPlan) { openSheet({ mode: 'upgrade', title: AUTOPILOT_LABEL[key] }); return; }
    const next = { ...autopilot, [key]: !autopilot[key] };
    const run = async () => {
      setBusyKey(key);
      // Optimistic: the switch answers immediately; a failure rolls it back.
      setSettings((s) => ({ ...s, autopilot: next }));
      try {
        await api('/api/app/autopilot', { method: 'POST', body: { categories: next } });
      } catch (e) {
        setSettings((s) => ({ ...s, autopilot }));
        throw e;
      } finally { setBusyKey(null); }
    };
    try { await gate(run, { kind: 'autopilot', id: key, title: `Autopilot: ${AUTOPILOT_LABEL[key].toLowerCase()}` }); } catch (e) { setNote(e.message); }
  }

  // Plan card copy per level, in their numbers.
  const price = access ? access.price_usd : 129;
  const planLine = level === 'active' || !access ? settings.plan_line
    : level === 'unlocked' ? `No plan yet. Core is $${price}/month${access.credit_applies ? `, your $${access.credit_usd || 20} comes off the first month` : ''}.`
      : `Free check. Your full report is $20; plans start at $${price}/month.`;

  const mail = (subject) => `mailto:hello@tryinsyt.com?subject=${encodeURIComponent(subject)}`;

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Your account</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Settings</h1>

      <Card className="mt-6 p-5">
        <div className="flex flex-col items-start gap-3 sm:flex-row">
          <CreditCard size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Plan</MonoLabel>
            <div className="mt-0.5 text-body font-medium">{planLine}</div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 pl-8 sm:pl-0">
            {level === 'locked' && <Button onClick={goUnlock} className="!px-4 !py-2">Unlock the full report, $20</Button>}
            {level === 'unlocked' && <Button onClick={() => openSheet({ title: 'Start your plan' })} className="!px-4 !py-2">Start Core</Button>}
            {(level === 'active' || !access) && <Link to="/app/plan"><Button variant="secondary" className="!px-4 !py-2">Change plan</Button></Link>}
            {(!access || access.has_customer) && <Button variant="secondary" onClick={portal} className="!px-4 !py-2">Manage card</Button>}
          </div>
        </div>
        <p className="mt-3 text-tiny text-neutral-900">
          {level === 'active' || !access
            ? 'Cancelling? The card page handles it - your subscription runs to the end of the period you paid for, Undo stays free for 30 days after, and your accounts stay exactly as they are.'
            : 'A plan applies the fixes you approve, checks again every week, and keeps a one-tap undo on everything. Cancel any time; your accounts stay exactly as they are.'}
        </p>
        <Pause access={access} onChange={(until) => { setAccess({ ...access, paused_until: until }); }} />
      </Card>

      <WeeklyCheck weekly={settings.weekly} />

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <Link2 size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Google connection</MonoLabel>
            <div className="mt-0.5 text-body">{settings.connection_status}</div>
            <LookAgain />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Link to="/app/connected"><Button variant="secondary" className="!px-4 !py-2">See what Insyt reads</Button></Link>
              <span className="text-tiny text-neutral-900">Every account, campaign, report and tag we can see through your Google permissions, live.</span>
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
                    <span className="whitespace-nowrap font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">
                      {access && !onAutopilotPlan ? (level === 'active' ? 'Autopilot' : 'Needs a plan') : autopilot[key] ? 'On' : 'Asks first'}
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

      <Emails emails={settings.emails} onChange={(emails) => setSettings((s) => ({ ...s, emails }))} />
      <Business business={settings.business} money={money} onSaved={(business) => setSettings((s) => ({ ...s, business }))} />

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

      <Card className="mt-3 p-5">
        <div className="flex items-start gap-3">
          <LogOut size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <div className="flex-1">
            <MonoLabel>Signed in</MonoLabel>
            <p className="mt-0.5 text-small text-neutral-900">
              Signing out only ends this browser session. Your weekly checks, your plan and the one-tap links in your emails carry on as they are.
            </p>
            <div className="mt-3">
              {isDemo()
                ? <Button variant="secondary" href="https://tryinsyt.com/" className="!px-4 !py-2">Leave the sample</Button>
                : <Button variant="secondary" href="/auth/signout" className="!px-4 !py-2">Sign out</Button>}
            </div>
            <People access={access} />
          </div>
        </div>
      </Card>

      {note && <div className="mt-4"><ErrorNote message={note} /></div>}
    </div>
  );
}
