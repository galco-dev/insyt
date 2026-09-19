// Funnel stage 5 - discovery confirmation (§7, fix plan move 1). One screen,
// one button. Each of the three doors shows an honest state: matched,
// choose between these, you do not use this, or this login cannot see it.
// An optional "leave alone" list fences whole campaigns before the first
// proposal exists. Never a configuration form.
import React, { useEffect, useState } from 'react';
import { CheckCircle as CheckCircle2, ChevronDown } from '@untitledui/icons';
import { api, isDemo, pushDL } from '../lib/api.js';
import { useRouter } from '../lib/router.jsx';
import { useAccess } from '../lib/access.jsx';
import { MonoLabel, Button, Card, Spinner, ErrorNote } from '../lib/ui.jsx';

const DOORS = [
  { kind: 'ads_account', label: 'Your ads account', unused: null },
  { kind: 'ga4_property', label: 'Your analytics', unused: 'No analytics on your site yet. The full check will say what that costs you, and we can set it up with you.' },
  { kind: 'gtm_container', label: 'Your tracking', unused: 'No Tag Manager on your site. Plenty of good setups skip it; we read your tracking through your analytics instead.' },
];
const DOT = { matched: 'bg-success', choose: 'bg-warning', unused: 'bg-neutral-800', cannot_see: 'bg-warning' };

function Row({ door, def, money, chosen, onChoose }) {
  const state = door.state;
  const name = (a) => a.display_name || a.external_id;
  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[state] || DOT.unused}`} />
        <div className="min-w-0 flex-1">
          <MonoLabel>{def.label}</MonoLabel>
          {state === 'matched' && (
            <div className="mt-0.5 text-body font-medium">{door.matched.map(name).join(', ')} <span className="text-small font-normal text-neutral-900">· on your site</span></div>
          )}
          {state === 'matched' && door.matched.some((a) => a.suspended) && <div className="mt-0.5 text-tiny text-warning">Google has suspended this account. We can read it, not fix it.</div>}
          {state === 'choose' && <div className="mt-0.5 text-body font-medium">{door.candidates.length === 1 ? 'Is this yours?' : `${door.candidates.length} to choose from`}</div>}
          {state === 'unused' && <div className="mt-0.5 text-small text-neutral-900">{def.unused}</div>}
          {state === 'cannot_see' && (
            <div className="mt-0.5 text-small text-neutral-900">
              {def.kind === 'ads_account' ? 'This Google account cannot see any ads account.' : 'Your site carries this, but this Google account cannot see it.'}
            </div>
          )}
        </div>
        {state === 'matched' && <CheckCircle2 size={18} className="shrink-0 text-success" aria-label="Matched to your site" />}
      </div>
      {state === 'choose' && (
        <div className="mt-3 flex flex-col gap-2 pl-5" role="radiogroup" aria-label={def.label}>
          {door.candidates.map((a) => {
            const on = chosen === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChoose(on ? null : a.id)}
                className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-left text-small ${on ? 'border-(--ui-cta-a) bg-(--ui-well)' : 'border-neutral-300'}`}
              >
                <span>
                  <span className="font-medium">{name(a)}</span>
                  {a.test_account && <span className="ml-2 font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">test account</span>}
                  {a.suspended && <span className="block text-tiny text-warning">Google has suspended this account. We can read it, not fix it.</span>}
                  {a.via_manager && <span className="block text-tiny text-neutral-900">via {a.via_manager}</span>}
                  {a.spend_30d_usd != null && <span className="block text-tiny text-neutral-900">{a.spend_30d_usd > 0 ? `${money(a.spend_30d_usd)} in the last 30 days` : 'nothing spent in the last 30 days'}</span>}
                </span>
                <span className={`font-mono text-tiny uppercase tracking-[0.1em] ${on ? 'text-strong' : 'text-neutral-900'}`}>{on ? 'this one' : 'choose'}</span>
              </button>
            );
          })}
          <span className="text-tiny text-neutral-900">Choose nothing and we leave it out. You can add it later from Settings.</span>
        </div>
      )}
    </div>
  );
}

// The business already has an Insyt account (fix plan move 12): ask the owner.
function AlreadyHere({ dup }) {
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState(null);
  async function ask() {
    setState('busy'); setMsg(null);
    try { await api('/api/app/join-request', { method: 'POST' }); setState('sent'); }
    catch (e) { setState('error'); setMsg(e.message); }
  }
  return (
    <Card className="mt-3 p-4" accent="info">
      <MonoLabel>Already on Insyt</MonoLabel>
      <p className="mt-1 text-small">{dup.business} already has an Insyt account. Ask the owner to add you and you will see everything they see; approvals stay theirs.</p>
      {state === 'sent'
        ? <p className="mt-2 text-small text-success">Asked. One tap on their side and you are in.</p>
        : <div className="mt-3 flex flex-wrap items-center gap-3"><Button variant="secondary" onClick={ask} disabled={state === 'busy'} className="!px-4 !py-2">Ask the owner to add me</Button>{msg && <span className="text-tiny text-critical">{msg}</span>}</div>}
    </Card>
  );
}

// "This login cannot see it": ask whoever holds the Google account, one email.
// Launch journey: no Google Ads account at all. We set one up under our
// manager account; it is theirs (their login is the admin, their card pays
// Google). Currency cannot change later, so it is the one thing we ask.
function CreateAdsAccount({ onDone }) {
  const [currency, setCurrency] = useState('USD');
  const [state, setState] = useState('idle'); // idle | busy | error
  const [msg, setMsg] = useState(null);
  async function create() {
    setState('busy'); setMsg(null);
    try {
      const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
      const r = await api('/api/app/ads-account', { method: 'POST', body: { currency, time_zone: tz } });
      onDone(r);
    } catch (e) { setState('error'); setMsg(e.message); }
  }
  return (
    <Card className="mt-3 p-4">
      <MonoLabel>No Google Ads account yet?</MonoLabel>
      <p className="mt-2 text-small text-neutral-900">
        We set it up for you. Afterwards you sign in to Google Ads once to accept the invitation and add a billing card. Google charges that card for clicks; Insyt never does. The account is yours from the first minute.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-tiny text-neutral-900">Currency you pay Google in
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency" className="ml-2 rounded border border-neutral-300 bg-page px-2 py-2 text-small">
            {['USD', 'GBP', 'EUR', 'AED', 'AUD', 'CAD', 'NZD', 'SAR', 'ZAR', 'INR', 'SGD'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <Button onClick={create} disabled={state === 'busy'} className="!px-5 !py-2.5">{state === 'busy' ? 'Setting it up' : 'Set up my Google Ads account'}</Button>
      </div>
      <p className="mt-2 text-tiny text-neutral-900">Currency cannot be changed later, so pick the one on the card you will use.</p>
      {msg && <div className="mt-3"><ErrorNote message={msg} /></div>}
    </Card>
  );
}

function AskSomeone() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState('idle'); // idle | busy | sent | error
  const [msg, setMsg] = useState(null);
  async function send() {
    setState('busy'); setMsg(null);
    try { await api('/api/app/access-request', { method: 'POST', body: { email } }); setState('sent'); }
    catch (e) { setState('error'); setMsg(e.message); }
  }
  if (state === 'sent') return <p className="mt-2 text-small text-success">Sent. When they connect, your check runs by itself.</p>;
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email of whoever runs your ads"
        type="email"
        inputMode="email"
        autoCapitalize="none"
        className="w-full rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)"
        aria-label="Email of whoever runs your ads"
      />
      <Button variant="secondary" onClick={send} disabled={state === 'busy' || !email.includes('@')} className="shrink-0 !px-4 !py-2">Ask them</Button>
      {msg && <span className="text-tiny text-critical">{msg}</span>}
    </div>
  );
}

export default function Confirm() {
  const { navigate } = useRouter();
  const { money } = useAccess();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState({});
  const [fenced, setFenced] = useState({});
  const [showFence, setShowFence] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/app/discovery').then((d) => {
      setData(d);
      const pre = {};
      for (const def of DOORS) { const door = d.doors && d.doors[def.kind]; if (door && door.suggested) pre[def.kind] = door.suggested; }
      setChosen(pre);
    }).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!data) return <Spinner label="Reading what your Google account can reach" />;

  // Older servers answer with matched/unmatched only; keep the screen working.
  const doors = data.doors || {
    ads_account: { state: 'unused', matched: [], candidates: [] }, ga4_property: { state: 'unused', matched: [], candidates: [] }, gtm_container: { state: 'unused', matched: [], candidates: [] },
  };
  const noAccess = !!data.no_access;
  const campaigns = data.campaigns || [];
  const anyMatched = DOORS.some((d) => doors[d.kind] && doors[d.kind].state === 'matched');
  const anyChosen = Object.values(chosen).some(Boolean);
  const canStart = !noAccess && (anyMatched || anyChosen);
  const money$ = (n) => (money ? money(n) : `$${Math.round(n).toLocaleString()}`);

  async function confirm() {
    setBusy(true);
    try {
      const exceptions = campaigns.filter((c) => fenced[c.id]).map((c) => ({ target: `campaign:${c.id}`, summary_text: `Leave "${c.name}" alone` }));
      const link = Object.values(chosen).filter(Boolean);
      await api('/api/app/confirm', { method: 'POST', body: { link, exceptions } });
      pushDL('confirm', { accounts_count: link.length + (doors.ads_account.state === 'matched' ? 1 : 0) + (doors.ga4_property.state === 'matched' ? 1 : 0) + (doors.gtm_container.state === 'matched' ? 1 : 0), has_ads: doors.ads_account.state === 'matched' || !!chosen.ads_account });
      // No tracking on the site at all: the first thing to fix is the setup, so land there (fix plan move 3).
      const noTracking = doors.gtm_container.state === 'unused' && doors.ga4_property.state !== 'matched';
      // Nothing running yet: the first ad comes before anything else (launch journey).
      navigate(!noAccess && campaigns.length === 0 ? '/app/first-ad' : noTracking ? '/app/journey' : '/app');
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-12">
      <MonoLabel>One tap and the check begins</MonoLabel>
      <h1 className="mt-2 text-h2 tracking-tight">{noAccess ? 'This Google account cannot see any ads or analytics.' : 'Here is what we can see.'}</h1>
      <p className="mt-2 max-w-[52ch] text-body text-neutral-900">
        {noAccess
          ? 'Sign in with the Google account that owns them, or type the email of whoever does and we will ask them for read access. Nothing changes in any account without your approval.'
          : `${data.site ? `Matched to ${data.site}. ` : ''}Green means the tracking on your pages told us. Nothing to configure.`}
      </p>

      {!noAccess && (
        <Card className="mt-6 divide-y divide-neutral-200">
          {DOORS.map((def) => (
            <Row key={def.kind} def={def} door={doors[def.kind]} money={money$} chosen={chosen[def.kind] || null} onChoose={(id) => setChosen((c) => ({ ...c, [def.kind]: id }))} />
          ))}
        </Card>
      )}

      {data.duplicate_of && <AlreadyHere dup={data.duplicate_of} />}

      {data.can_create_ads_account && (noAccess || (doors.ads_account.state !== 'matched' && !(doors.ads_account.candidates || []).length)) && (
        <CreateAdsAccount onDone={async () => {
          // The new account is linked already; confirming still queues the first check and starts the weekly rhythm.
          try { await api('/api/app/confirm', { method: 'POST', body: { link: [], exceptions: [] } }); pushDL('confirm', { accounts_count: 1, has_ads: true }); } catch { /* the first check can start later */ }
          navigate('/app/first-ad');
        }} />
      )}

      {(noAccess || doors.ads_account.state === 'cannot_see') && (
        <Card className="mt-3 p-4">
          <MonoLabel>Someone else runs your ads?</MonoLabel>
          <AskSomeone />
        </Card>
      )}

      {!noAccess && campaigns.length > 0 && (
        <div className="mt-4">
          <button type="button" onClick={() => setShowFence(!showFence)} className="flex items-center gap-1.5 text-small text-neutral-900 underline underline-offset-2" aria-expanded={showFence}>
            <ChevronDown size={14} className={showFence ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden />
            Anything we should leave alone? <span className="font-mono text-tiny uppercase tracking-[0.1em]">optional</span>
          </button>
          {showFence && (
            <Card className="mt-3 divide-y divide-neutral-200">
              {campaigns.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-3 p-3 text-small">
                  <input type="checkbox" checked={!!fenced[c.id]} onChange={(e) => setFenced((f) => ({ ...f, [c.id]: e.target.checked }))} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.spend_30d_usd != null && <span className="shrink-0 text-tiny text-neutral-900">{money$(c.spend_30d_usd)} / 30 days</span>}
                </label>
              ))}
              <p className="p-3 text-tiny text-neutral-900">Ticked campaigns are never touched, not even by Autopilot. Change your mind any time in Settings.</p>
            </Card>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button onClick={confirm} disabled={busy || !canStart} className="w-full sm:w-auto">
          {busy ? 'Starting your check…' : 'Yes - run my free check'}
        </Button>
        <Button variant="ghost" href={isDemo() ? '/app/start?demo=1' : '/auth/google/start?step=discovery&switch=1'}>Not the account you meant? Switch</Button>
      </div>
      <p className="mt-3 text-tiny text-neutral-900">{canStart ? 'Still read-only. Your report arrives by email in a few minutes.' : noAccess ? 'The check waits until an account that can see your ads is connected.' : 'Choose at least one account to start.'}</p>
    </div>
  );
}
