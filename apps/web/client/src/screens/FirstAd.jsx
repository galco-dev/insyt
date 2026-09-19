// Your first ad (launch journey). A business with nothing running lands here
// after Google sign-in: one short form, then the draft appears below with
// the same two taps every ad gets - create it switched off, then switch it on.
// The plan starts on the first tap; nothing spends until the second.
import React, { useEffect, useState } from 'react';
import { api, safeStorage } from '../lib/api.js';
import { useAccess } from '../lib/access.jsx';
import { MonoLabel, Card, Button, Spinner, ErrorNote, Receipt } from '../lib/ui.jsx';
import { YourAds } from './Approvals.jsx';
import { TrackingBlock } from './TrackingBlock.jsx';
import { goWriteStep } from '../lib/fix-access.js';

const field = 'mt-1 w-full rounded border border-neutral-300 bg-page px-3 py-2.5 text-body outline-none focus:border-neutral-500';

export default function FirstAd() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [service, setService] = useState('');
  const [city, setCity] = useState('');
  const [budget, setBudget] = useState('10');
  const [places, setPlaces] = useState([]); // Google's matches for what they typed
  const [place, setPlace] = useState(null); // the one they chose
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [drafted, setDrafted] = useState(0);
  const [tracking, setTracking] = useState(false);
  const [trackingKey, setTrackingKey] = useState(0);
  const { money, access } = useAccess();
  // Back from Google's write consent with ?tracking=1: finish what the tick box started.
  // Back from Google's write consent: the tick box was remembered for the tab, so finish it now.
  useEffect(() => {
    if (safeStorage.get('insyt_tracking_pending') !== '1') return;
    safeStorage.del('insyt_tracking_pending');
    if (/[?&]fix_access=1/.test(window.location.search)) window.history.replaceState({}, '', window.location.pathname);
    startTracking();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function startTracking() {
    try {
      const r = await api('/api/app/tracking/start', { method: 'POST', body: {} });
      if (r && r.started === false) setNote({ tone: 'error', text: r.error_line || 'Google did not let us set up tracking just now. Try again in a minute.' });
      setTrackingKey((k) => k + 1);
    } catch (e) { setNote({ tone: 'error', text: e.message }); }
  }
  useEffect(() => {
    api('/api/app/first-ad').then((d) => { setInfo(d); if (d && d.service) setService(d.service); }).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!info) return <Spinner label="Getting your first ad ready" />;

  const hasDraft = (info.drafts_count || 0) + drafted > 0;

  // The place must be one Google knows: as they type, ask for matches and let them pick.
  async function lookUp(text) {
    setCity(text); setPlace(null);
    const q = text.trim();
    if (q.length < 2) { setPlaces([]); return; }
    setSearching(true);
    try { const r = await api(`/api/app/locations?q=${encodeURIComponent(q)}`); setPlaces(r.locations || []); } catch { setPlaces([]); }
    setSearching(false);
  }

  async function draft(e) {
    if (e && e.preventDefault) e.preventDefault();
    const s = service.trim();
    const b = Math.round(Number(budget));
    if (!s) { setNote({ tone: 'error', text: 'Tell us what people should find you for, like "Dentist" or "Emergency plumber".' }); return; }
    if (!place) { setNote({ tone: 'error', text: places.length ? 'Pick your area from the list, so the ad only shows to people there.' : 'Type the city or area your customers are in and pick it from the list.' }); return; }
    if (!(b >= 5 && b <= 500)) { setNote({ tone: 'error', text: 'Pick a daily budget between 5 and 500.' }); return; }
    setBusy(true); setNote(null);
    try {
      await api('/api/app/drafts', { method: 'POST', body: { template: 'generic', inputs: { services: [s], location: place.canonical_name, geo_target_id: place.id, budget_daily_usd: b } } });
      setDrafted((n) => n + 1);
      setNote({ tone: 'success', text: `Drafted. Read it below and change any wording you like. Nothing is created in Google until you tap "Create it, switched off", and nothing spends until you switch it on.` });
      if (tracking) {
        // Creating things in their Google account needs Google's write consent, asked once, then back here.
        if (access && access.fix_access === 'ask') { safeStorage.set('insyt_tracking_pending', '1'); goWriteStep('/app/first-ad'); return; }
        await startTracking();
      }
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Your first ad</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">{hasDraft ? 'Your first ad is drafted.' : 'Nothing is running yet. Let us draft your first ad.'}</h1>
      <p className="mt-2 max-w-[52ch] text-body text-neutral-900">
        {hasDraft
          ? 'Two taps take it live: the first creates it in your Google Ads switched off, the second switches it on. You can change the wording before either.'
          : `We write it from ${info.website || 'your website'}: who sees it, what it says, and what you pay each day, in plain words. It starts switched off and only ever shows to people searching in your area.`}
      </p>

      {!hasDraft && (
        <Card className="mt-6 p-5">
          <form onSubmit={draft}>
            <label className="block text-tiny text-neutral-900">What should people find you for?
              <input value={service} onChange={(e) => setService(e.target.value)} placeholder="Dentist" maxLength={60} className={field} aria-label="Service" />
            </label>
            <label className="mt-4 block text-tiny text-neutral-900">Where are your customers?
              <input value={city} onChange={(e) => lookUp(e.target.value)} placeholder="Your city or area" maxLength={80} className={field} aria-label="City or area" autoCapitalize="words" autoComplete="off" />
            </label>
            {place ? (
              <p className="mt-2 text-small">Showing to people in <strong>{place.canonical_name}</strong>. <button type="button" onClick={() => { setPlace(null); setCity(''); setPlaces([]); }} className="underline underline-offset-2">Change</button></p>
            ) : (
              (searching || places.length > 0) && (
                <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-300 bg-neutral-50 text-small" aria-label="Matching places">
                  {searching && !places.length && <li className="px-3 py-2 text-neutral-900">Looking up places</li>}
                  {places.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => { setPlace(p); setCity(p.name); setPlaces([]); }} className="w-full px-3 py-2 text-left hover:bg-neutral-100">{p.canonical_name}</button>
                    </li>
                  ))}
                </ul>
              )
            )}
            {!place && city.trim().length >= 2 && !searching && !places.length && (
              <p className="mt-2 text-tiny text-neutral-900">No place with that name in Google's list. Try the nearest town or the county.</p>
            )}
            <label className="mt-4 block text-tiny text-neutral-900">Most to spend a day
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="numeric" className={field} aria-label="Daily budget" />
            </label>
            <p className="mt-1 text-tiny text-neutral-900">In {access && access.currency ? access.currency : 'your account currency'}. You only pay for clicks, and the ad starts switched off.</p>
            <label className="mt-4 flex items-start gap-2 text-small">
              <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} className="mt-1" />
              <span>Shall we also set up tracking (Google Analytics / Google Tag Manager)?</span>
            </label>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={draft} disabled={busy} className="!px-5 !py-2.5">{busy ? 'Writing your ad' : 'Draft my ad'}</Button>
              <span className="text-tiny text-neutral-900">Switched off until you say go. Nothing is created until you tap.</span>
            </div>
          </form>
        </Card>
      )}

      {note && <div className="mt-4">{note.tone === 'error' ? <ErrorNote message={note.text} /> : <Receipt tone={note.tone}>{note.text}</Receipt>}</div>}

      {hasDraft && <YourAds key={drafted} />}
      <TrackingBlock refreshKey={trackingKey} />

      <p className="mt-6 text-tiny text-neutral-900">
        Every ad we create starts paused, is watched for 48 hours once it is on, and can be paused again with one tap from History.
      </p>
    </div>
  );
}
