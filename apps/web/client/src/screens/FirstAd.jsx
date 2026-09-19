// Your first ad (launch journey). A business with nothing running lands here
// after Google sign-in: one short form, then the draft appears below with
// the same two taps every ad gets - create it switched off, then switch it on.
// The plan starts on the first tap; nothing spends until the second.
import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
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
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [drafted, setDrafted] = useState(0);
  const [tracking, setTracking] = useState(false);
  const [trackingKey, setTrackingKey] = useState(0);
  const { money, access } = useAccess();
  // Back from Google's write consent with ?tracking=1: finish what the tick box started.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('tracking') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      api('/api/app/tracking/start', { method: 'POST', body: {} }).then(() => setTrackingKey((k) => k + 1)).catch((e) => setNote({ tone: 'error', text: e.message }));
    }
  }, []);
  useEffect(() => {
    api('/api/app/first-ad').then((d) => { setInfo(d); if (d && d.service) setService(d.service); }).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!info) return <Spinner label="Getting your first ad ready" />;

  const hasDraft = (info.drafts_count || 0) + drafted > 0;

  async function draft(e) {
    if (e && e.preventDefault) e.preventDefault();
    const s = service.trim();
    const c = city.trim();
    if (!s) { setNote({ tone: 'error', text: 'Tell us what people should find you for, like "Dentist" or "Emergency plumber".' }); return; }
    if (!c) { setNote({ tone: 'error', text: 'Tell us the city or area your customers are in, so the ad only shows there.' }); return; }
    setBusy(true); setNote(null);
    try {
      await api('/api/app/drafts', { method: 'POST', body: { template: 'generic', inputs: { services: [s], location: c } } });
      setDrafted((n) => n + 1);
      setNote({ tone: 'success', text: `Drafted. Read it below and change any wording you like. Nothing is created in Google until you tap "Create it, switched off", and nothing spends until you switch it on.` });
      if (tracking) {
        // Creating things in their Google account needs Google's write consent, asked once, then back here.
        if (access && access.fix_access === 'ask') { goWriteStep('/app/first-ad?tracking=1'); return; }
        await api('/api/app/tracking/start', { method: 'POST', body: {} });
        setTrackingKey((k) => k + 1);
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
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Your city or area" maxLength={80} className={field} aria-label="City or area" autoCapitalize="words" />
            </label>
            <label className="mt-4 flex items-start gap-2 text-small">
              <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} className="mt-1" />
              <span>Shall we also set up tracking (Google Analytics / Google Tag Manager)?</span>
            </label>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={draft} disabled={busy} className="!px-5 !py-2.5">{busy ? 'Writing your ad' : 'Draft my ad'}</Button>
              <span className="text-tiny text-neutral-900">Starts at {money ? money(10) : '$10'} a day, switched off. Nothing is created until you say so.</span>
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
