// Your tracking (launch journey, offered never required). Shown under the
// first ad and on the setup screen once the customer asked for it: what we
// created in their Google account, the one paste for their builder, a
// hand-off to their web person, and the quiet check that verifies it.
import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { MonoLabel, Card, Button, ErrorNote, Receipt } from '../lib/ui.jsx';
import { guideFor, codeFor } from '../lib/tracking-guides.js';

export function TrackingBlock({ refreshKey = 0 }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(null);
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { api('/api/app/tracking').then(setState).catch((e) => setError(e.message)); }, [refreshKey]);

  if (error) return <div className="mt-8"><ErrorNote message={error} /></div>;
  if (!state || !state.started) return null;

  const guide = guideFor(state.platform);
  const code = state.gtm_id ? codeFor(state.gtm_id) : null;
  const live = !!state.verified_at || state.tag_live;

  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setNote({ tone: 'error', text: 'Copying did not work here. Select the code and copy it yourself.' }); }
  }
  async function checkNow() {
    setBusy('check'); setNote(null);
    try { await api('/api/app/tracking/check', { method: 'POST', body: {} }); setNote({ tone: 'info', text: 'Checking your site now. This takes a minute or two; we email you the moment it is live.' }); }
    catch (e) { setNote({ tone: 'error', text: e.message }); }
    setBusy(null);
  }
  async function handoff() {
    setBusy('handoff'); setNote(null);
    try { const r = await api('/api/app/tracking/handoff', { method: 'POST', body: { email } }); setNote({ tone: 'success', text: `Sent to ${r.sent_to}. They get the code and the exact steps; we keep checking your site and tell you when it is live.` }); setEmail(''); }
    catch (e) { setNote({ tone: 'error', text: e.message }); }
    setBusy(null);
  }

  return (
    <div className="mt-8">
      <MonoLabel>Your tracking</MonoLabel>
      <Card className="mt-3 p-5">
        {live ? (
          <>
            <div className="text-body font-medium">Tracking is live on {state.website || 'your site'}.</div>
            <p className="mt-1 text-small text-neutral-900">Visits and bookings are being counted. Your report shows what your ads bring in, not just what they cost.</p>
          </>
        ) : (
          <>
            <div className="text-body font-medium">
              {state.gtm_id ? 'Set up in your Google account. One paste on your website and it is live.' : 'Setting up in your Google account.'}
            </div>
            <p className="mt-1 text-small text-neutral-900">
              {state.gtm_id
                ? `We check ${state.website || 'your site'} every few minutes and tell you the moment the code appears. Nothing to confirm.`
                : 'If Google asks you to create an account first, it is one minute on their side; we finish the rest.'}
            </p>
            {code && (
              <>
                <div className="mt-4 text-small font-medium">1. Copy your tracking code</div>
                <pre className="mt-2 max-h-40 overflow-auto rounded border border-neutral-300 bg-neutral-50 p-3 font-mono text-tiny whitespace-pre-wrap break-all">{code}</pre>
                <Button variant="secondary" onClick={copy} className="mt-2 !px-4 !py-2">{copied ? 'Copied' : 'Copy the code'}</Button>
                <div className="mt-4 text-small font-medium">2. Paste it on {guide.name}</div>
                <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-small text-neutral-900">
                  {guide.steps.map((st) => <li key={st}>{st}</li>)}
                </ol>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button variant="secondary" onClick={checkNow} disabled={busy === 'check'} className="!px-4 !py-2">I have pasted it</Button>
                  <span className="text-tiny text-neutral-900">Or leave it: we keep checking on our own.</span>
                </div>
                <div className="mt-5 border-t border-neutral-300 pt-4">
                  <div className="text-small font-medium">Someone else looks after your website?</div>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoCapitalize="none" placeholder="their@email.com" aria-label="Email of whoever looks after your website" className="min-w-0 flex-1 rounded border border-neutral-300 bg-page px-3 py-2.5 text-body outline-none focus:border-neutral-500" />
                    <Button variant="secondary" onClick={handoff} disabled={busy === 'handoff' || !email.includes('@')} className="shrink-0 !px-4 !py-2">Send them the code</Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
        {note && <div className="mt-3">{note.tone === 'error' ? <ErrorNote message={note.text} /> : <Receipt tone={note.tone}>{note.text}</Receipt>}</div>}
      </Card>
      {!live && <p className="mt-2 text-tiny text-neutral-900">Your ad does not wait for this. It runs on clicks until counting is live, then we offer the switch to aiming for bookings.</p>}
    </div>
  );
}
