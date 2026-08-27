// Funnel stage 1–3: URL paste → crawl theatre → findings strip → Google sign-in.
// Public (no session). §5 crawl endpoints; strip shape from findings-strip.js.
import React, { useEffect, useRef, useState } from 'react';
import { SearchMd as Search, CheckCircle as CheckCircle2, AlertTriangle, ShieldTick as ShieldCheck } from '@untitledui/icons';
import { api, isDemo } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { MonoLabel, Button, Card, ErrorNote } from '../lib/ui.jsx';

const STAGES = [
  'Opening your website…',
  'Reading every page a customer would…',
  'Looking for your tracking…',
  'Watching what fires when the page loads…',
  'Writing up what we can see from the outside…',
];

const DEMO_STRIP = {
  headline: '2 things worth fixing, visible from the outside',
  items: [
    'Google tracking installed',
    'Outdated tracking still running - it stopped collecting data in 2023',
    "Tracking is installed but we couldn't see it recording visits",
  ],
  visible_issue_count: 2,
};

export default function Start() {
  const [url, setUrl] = useState('');
  const [state, setState] = useState('idle'); // idle | crawling | done | failed
  const [stage, setStage] = useState(0);
  const [strip, setStrip] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const autoRef = useRef(false);

  useEffect(() => () => clearInterval(pollRef.current), []);

  // Arriving from the marketing site's hero paste box (?url=…): start the
  // check immediately - the visitor already typed their address once.
  useEffect(() => {
    if (autoRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const fromHero = params.get('url');
    const resume = params.get('crawl');
    if (params.get('declined')) setError('No problem - nothing was connected. Paste your address whenever you want to try again.');
    if (resume) {
      // An in-flight or finished check (old /check/:id links): pick it up,
      // never ask for the address again.
      autoRef.current = true;
      setTimeout(() => begin(null, resume), 0);
    } else if (fromHero && fromHero.trim()) {
      autoRef.current = true;
      setUrl(fromHero.trim());
      setTimeout(() => begin(fromHero.trim()), 0);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function begin(given, resumeId = null) {
    const target = (typeof given === 'string' ? given : url).trim();
    setError(null);
    if (!target && !resumeId) { setError('Type your website address - like glowstudio.ae'); return; }
    setState('crawling'); setStage(0);
    const stageTimer = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 2600);

    if (isDemo()) {
      setTimeout(() => { clearInterval(stageTimer); setStrip(DEMO_STRIP); setState('done'); }, 4200);
      return;
    }
    try {
      const { id } = resumeId ? { id: resumeId } : await api('/api/crawl', { method: 'POST', body: { url: target } });
      const startedAt = Date.now();
      pollRef.current = setInterval(async () => {
        try {
          const c = await api(`/api/crawl/${id}`);
          if (c.status && c.status !== 'running') {
            clearInterval(pollRef.current); clearInterval(stageTimer);
            if (c.strip) { setStrip(c.strip); setState('done'); } else { setState('failed'); }
          } else if (Date.now() - startedAt > 4 * 60_000) {
            // Never spin forever: after four minutes, say so and offer a retry.
            clearInterval(pollRef.current); clearInterval(stageTimer);
            setState('failed');
          }
        } catch (e) {
          if (e && e.status === 404) {
            // Expired or unknown check (old link, server restart): back to the address, once.
            clearInterval(pollRef.current); clearInterval(stageTimer);
            setState('idle'); setError('That check has expired - paste your address and we will run it again.');
          }
        }
      }, 1500);
    } catch (e) {
      clearInterval(stageTimer);
      setError(e.message); setState('idle');
    }
  }

  const site = url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24">
      <section className="pt-14 text-center">
        {state === 'idle' && (
          <>
            <MonoLabel>Free check · 3 minutes · no email needed</MonoLabel>
            <h1 className="mx-auto mt-3 max-w-[26ch] text-h1 tracking-tight">
              Your Google Ads, watched and fixed every week.
            </h1>
            <p className="mx-auto mt-3 max-w-[48ch] text-body text-neutral-900">
              Paste your website. We read it like a customer would, check your tracking from the outside, and show you
              what we find - before you sign in to anything.
            </p>
          </>
        )}
        {state === 'crawling' && (
          <>
            <MonoLabel>Free check · step 1 of 3</MonoLabel>
            <h1 className="mx-auto mt-3 max-w-[26ch] text-h1 tracking-tight">Checking {site || 'your website'}</h1>
            <p className="mx-auto mt-3 max-w-[48ch] text-body text-neutral-900">
              Reading your site the way a customer would. Nothing to do here - your results appear on this page.
            </p>
          </>
        )}
        {state === 'done' && (
          <>
            <MonoLabel>Free check · step 2 of 3</MonoLabel>
            <h1 className="mx-auto mt-3 max-w-[26ch] text-h1 tracking-tight">Here's what we found on {site || 'your website'}</h1>
            <p className="mx-auto mt-3 max-w-[48ch] text-body text-neutral-900">
              This is only what any visitor can see. The full check reads your Google Ads and tracking from the inside.
            </p>
          </>
        )}
        {state === 'failed' && (
          <>
            <MonoLabel>Free check</MonoLabel>
            <h1 className="mx-auto mt-3 max-w-[26ch] text-h1 tracking-tight">We couldn't reach {site || 'that website'}</h1>
          </>
        )}
      </section>

      {state === 'idle' && (
        <div className="mx-auto mt-8 max-w-s2">
          <div className="flex overflow-hidden rounded border border-neutral-500 bg-(--ui-well) focus-within:border-(--ui-focus)">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && begin()}
              placeholder="yourwebsite.com"
              className="w-full bg-transparent px-4 py-3.5 text-body outline-none placeholder:text-neutral-800"
              aria-label="Your website address"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="url"
              autoFocus
            />
            <button type="button" onClick={begin} className="flex items-center gap-2 whitespace-nowrap bg-(--ui-cta-a) px-5 text-small font-medium text-page">
              <Search size={15} aria-hidden /> Check my site
            </button>
          </div>
          {error && <div className="mt-3"><ErrorNote message={error} /></div>}
          <p className="mt-3 text-center text-tiny text-neutral-900">
            Read-only, always. Want to see what you get first?{' '}
            <Link to="/app/report" className="underline underline-offset-2">Open a sample report</Link>.
          </p>
        </div>
      )}

      {state === 'crawling' && (
        <Card className="mx-auto mt-8 max-w-s2 p-6">
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-400 border-t-(--ui-cta-a)" aria-hidden />
            <div className="text-body font-medium" aria-live="polite">{STAGES[stage]}</div>
          </div>
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-neutral-200">
            <div className="h-full bg-(--ui-cta-a) transition-all duration-1000" style={{ width: `${((stage + 1) / STAGES.length) * 90}%` }} />
          </div>
          <p className="mt-3 text-tiny text-neutral-900">Usually under three minutes. We only look at what any visitor can see.</p>
        </Card>
      )}

      {state === 'done' && strip && (
        <div className="mx-auto mt-8 max-w-s2">
          <Card className="p-6">
            <MonoLabel>What we can see from the outside</MonoLabel>
            <h2 className="mt-2 text-h5">{strip.headline}</h2>
            <ul className="mt-4 flex flex-col gap-2.5">
              {strip.items.map((item) => {
                const issue = /no |outdated|double|more than one|couldn't|invisible/i.test(item);
                const IconEl = issue ? AlertTriangle : CheckCircle2;
                return (
                  <li key={item} className="flex items-start gap-2 text-small">
                    <IconEl size={15} className={issue ? 'mt-0.5 shrink-0 text-warning' : 'mt-0.5 shrink-0 text-success'} aria-hidden />
                    {item}
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card className="mt-3 p-6">
            <div className="flex items-start gap-2.5">
              <ShieldCheck size={17} className="mt-0.5 shrink-0 text-success" aria-hidden />
              <p className="text-small text-neutral-900">
                The full check looks inside - every dollar, every setting. <strong className="text-strong">Read-only: we can look, not touch.</strong>{' '}
                Nothing ever changes without your approval.
              </p>
            </div>
            <ol className="mt-4 flex flex-col gap-2 border-t border-neutral-200 pt-4">
              {[
                'You pick your Google account - one tap.',
                'We read everything, look-only. Nothing changes.',
                'Your full report is ready in about ten minutes.',
              ].map((step, i) => (
                <li key={step} className="flex items-start gap-2.5 text-small text-neutral-900">
                  <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-neutral-100 font-mono text-tiny" aria-hidden>{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <Button href={isDemo() ? '/app/confirm?demo=1' : `/auth/google/start?step=discovery&site=${encodeURIComponent(site)}`} className="mt-4 w-full">
              Continue with Google - run my free check
            </Button>
            <p className="mt-2 text-center text-tiny text-neutral-900">You choose the account. Disconnect any time.</p>
          </Card>
        </div>
      )}

      {state === 'failed' && (
        <div className="mx-auto mt-8 max-w-s2">
          <ErrorNote message="Check the address and try again - or try without www. If your site is behind a password or a bot-check, the free check can't read it, but the full check still can." />
          <Button variant="secondary" className="mt-4 w-full" onClick={() => setState('idle')}>Try another address</Button>
          <Button href={`/auth/google/start?step=discovery&site=${encodeURIComponent(site)}`} className="mt-2 w-full">Skip ahead - run the full check with Google</Button>
        </div>
      )}
    </div>
  );
}
