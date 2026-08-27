// Approvals queue - §11. One card per waiting fix; approve or dismiss.
// Each card can open to show exactly what changes (the trust layer), and the
// request composer at the foot lets the owner ask for anything in a sentence.
import React, { useEffect, useState } from 'react';
import { ChevronDown } from '@untitledui/icons';
import clsx from 'clsx';
import { api } from '../lib/api.js';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote } from '../lib/ui.jsx';

function Detail({ p }) {
  if (!p.explanation && !p.before_line && !p.after_line) return null;
  return (
    <div className="mt-3 rounded border border-neutral-300 bg-neutral-50 p-4 text-small">
      {p.explanation && <p>{p.explanation}</p>}
      {p.before_line && (
        <p className={clsx(p.explanation && 'mt-2')}>
          <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">Now </span>
          {p.before_line}
        </p>
      )}
      {p.after_line && (
        <p className="mt-1">
          <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">After </span>
          {p.after_line}
        </p>
      )}
    </div>
  );
}

function RequestComposer() {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle | busy | sent | error
  const [errMsg, setErrMsg] = useState(null);

  async function send() {
    if (!text.trim()) return;
    setState('busy');
    try {
      await api('/api/app/request-change', { method: 'POST', body: { text: text.trim() } });
      setState('sent');
      setText('');
    } catch (e) {
      setErrMsg(e.message);
      setState('error');
    }
  }

  return (
    <Card className="mt-8 p-5">
      <MonoLabel>Ask for anything</MonoLabel>
      <p className="mt-1 text-small text-neutral-900">
        Want a budget changed, ads paused for a holiday, or anything else? Say it in a sentence.
        We draft it as a change and it lands right here for your approval.
      </p>
      {state === 'sent' ? (
        <div className="mt-3 rounded border border-neutral-300 bg-neutral-50 p-4 text-small">
          Got it. Your request is on the record and we will draft it as a change for your approval, usually within a day.{' '}
          <button type="button" onClick={() => setState('idle')} className="underline underline-offset-2">Ask something else</button>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="For example: keep my spend under $40 a day until March"
            aria-label="What would you like changed?"
            className="mt-3 w-full resize-none rounded border border-neutral-300 bg-page p-3 text-body outline-none focus:border-neutral-500"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-tiny text-neutral-900">Nothing is applied until you approve the drafted change.</span>
            <Button onClick={send} disabled={state === 'busy' || !text.trim()} className="!px-5 !py-2.5">
              {state === 'busy' ? 'Sending' : 'Send request'}
            </Button>
          </div>
          {state === 'error' && <div className="mt-2"><ErrorNote message={errMsg} /></div>}
        </>
      )}
    </Card>
  );
}

// §5 consumer door: "your ad" drafts in the customer register. Created
// paused on the first yes; switched on by a second, separate yes. A draft
// that cannot ship yet is staged behind the setup checklist (§5.1) — never
// a dead end.
function YourAds() {
  const [drafts, setDrafts] = useState(null);
  const [setup, setSetup] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [editing, setEditing] = useState({});
  useEffect(() => {
    api('/api/app/drafts').then((d) => setDrafts(d.drafts || [])).catch(() => setDrafts([]));
    api('/api/app/setup').then(setSetup).catch(() => setSetup(null));
  }, []);
  if (!drafts || !drafts.length) return null;
  const stepsLeft = setup && setup.steps ? setup.steps.filter((s) => !s.done) : [];

  async function act(id, action, body) {
    setBusy(id); setNote(null);
    try {
      const r = await api(`/api/app/drafts/${id}/${action}`, { method: 'POST', body: body || {} });
      if (r.status === 'staged') setNote('Your campaign is ready. It waits behind the setup steps below; it switches to "create" the moment they clear.');
      if (r.warnings && r.warnings.length) setNote(r.warnings.join(' '));
      setDrafts((xs) => xs.map((d) => (d.id === id ? { ...d, status: r.status || d.status, gates: r.blockers ? { ok: false, blockers: r.blockers, steps: r.steps } : d.gates, ...(r.spec ? { ad_groups: r.spec.ad_groups.map((g) => ({ name: g.name, rsa: g.rsa })) } : {}) } : d)).filter((d) => d.status !== 'dismissed'));
      if (action === 'edit') setEditing((e) => ({ ...e, [id]: false }));
    } catch (e) { setNote(e.message); }
    setBusy(null);
  }
  async function provision() {
    setBusy('setup'); setNote(null);
    try {
      const r = await api('/api/app/setup/provision', { method: 'POST' });
      const done = [r.ga4 && 'visit tracking', r.gtm && 'the tracking code'].filter(Boolean);
      setNote(done.length ? `Done: we set up ${done.join(' and ')} for you.` : (r.guides && r.guides.length ? r.guides[0].detail : 'Nothing left for us to set up.'));
      api('/api/app/setup').then(setSetup).catch(() => {});
    } catch (e) { setNote(e.message); }
    setBusy(null);
  }

  return (
    <div className="mt-8">
      <MonoLabel>Your ads</MonoLabel>
      <div className="mt-3 flex flex-col gap-3">
        {drafts.map((d) => {
          const staged = d.status === 'draft' && d.gates && d.gates.ok === false;
          const g = d.ad_groups && d.ad_groups[0];
          const edit = editing[d.id];
          return (
            <Card key={d.id} className="p-5">
              <div className="text-body font-medium">{d.plain.headline}</div>
              <div className="mt-1 text-small text-neutral-900">{d.plain.who_sees_it} {d.plain.what_you_pay}</div>
              {g && !edit && (
                <div className="mt-3 rounded border border-neutral-300 bg-neutral-50 p-4 text-small">
                  <div className="font-medium">{g.rsa.headlines.slice(0, 3).join(' · ')}</div>
                  <div className="mt-1 text-neutral-900">{g.rsa.descriptions[0]}</div>
                  {d.status === 'draft' && (
                    <button type="button" onClick={() => setEditing((e) => ({ ...e, [d.id]: { headlines: g.rsa.headlines.join('\n'), descriptions: g.rsa.descriptions.join('\n') } }))} className="mt-2 text-small underline underline-offset-2">Change the wording</button>
                  )}
                </div>
              )}
              {g && edit && (
                <div className="mt-3 flex flex-col gap-2 text-small">
                  <label className="text-tiny text-neutral-900">Headlines, one per line (30 letters each at most)</label>
                  <textarea value={edit.headlines} onChange={(e) => setEditing((x) => ({ ...x, [d.id]: { ...edit, headlines: e.target.value } }))} rows={5} className="w-full rounded border border-neutral-300 bg-page p-2 text-small outline-none focus:border-neutral-500" />
                  <label className="text-tiny text-neutral-900">Descriptions, one per line (90 letters each at most)</label>
                  <textarea value={edit.descriptions} onChange={(e) => setEditing((x) => ({ ...x, [d.id]: { ...edit, descriptions: e.target.value } }))} rows={3} className="w-full rounded border border-neutral-300 bg-page p-2 text-small outline-none focus:border-neutral-500" />
                  <div className="flex gap-2">
                    <Button onClick={() => act(d.id, 'edit', { ad_groups: [{ name: g.name, rsa: { headlines: edit.headlines.split('\n').map((x) => x.trim()).filter(Boolean), descriptions: edit.descriptions.split('\n').map((x) => x.trim()).filter(Boolean) } }] })} disabled={busy === d.id} className="!px-4 !py-2">Save wording</Button>
                    <Button variant="ghost" onClick={() => setEditing((e) => ({ ...e, [d.id]: false }))} className="!py-2">Cancel</Button>
                  </div>
                </div>
              )}
              {staged && (
                <div className="mt-3 rounded border border-neutral-300 bg-neutral-50 p-4 text-small">
                  <div className="font-medium">Ready, waiting on setup</div>
                  <ul className="mt-2 flex flex-col gap-1">
                    {(d.gates.steps || []).filter((s) => !s.done).map((st) => (
                      <li key={st.key}>{st.insyt_does_it ? 'We do this: ' : ''}{st.label}{st.detail ? ` - ${st.detail}` : ''}</li>
                    ))}
                  </ul>
                  {stepsLeft.some((s) => s.insyt_does_it) && (
                    <Button onClick={provision} disabled={busy === 'setup'} className="mt-3 !px-4 !py-2">Set it up for me</Button>
                  )}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                {d.status === 'draft' && <Button onClick={() => act(d.id, 'approve')} disabled={busy === d.id} className="!px-5 !py-2.5">Create it, switched off</Button>}
                {d.status === 'created_paused' && <Button onClick={() => act(d.id, 'enable')} disabled={busy === d.id} className="!px-5 !py-2.5">Switch it on</Button>}
                {d.status === 'enabled' && <span className="font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">Live</span>}
                {d.status !== 'enabled' && <Button variant="secondary" onClick={() => act(d.id, 'dismiss')} disabled={busy === d.id} className="!px-5 !py-2.5">Not now</Button>}
              </div>
              <p className="mt-2 text-tiny text-neutral-900">{d.plain.safety_line}</p>
            </Card>
          );
        })}
      </div>
      {note && <div className="mt-3"><ErrorNote message={note} /></div>}
    </div>
  );
}

export default function Approvals() {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState({});

  const load = () => api('/api/app/approvals').then((d) => setPending(d.pending)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function act(kind, id) {
    setBusy(id);
    try {
      // Dismissals carry whether the detail was opened first (§11.2 label:
      // "the finding is wrong" vs "the explanation failed").
      const body = kind === 'dismiss' ? { expanded_first: !!open[id] } : undefined;
      await api(`/api/app/${kind}/${id}`, { method: 'POST', body });
      setPending((p) => p.filter((x) => x.id !== id));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!pending) return <Spinner label="Loading approvals" />;

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Nothing changes without your yes</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Approvals</h1>

      {pending.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="All clear" body="Every suggested fix has been handled. The next weekly check may bring more." />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {pending.map((p) => {
            const hasDetail = !!(p.explanation || p.before_line || p.after_line);
            const isOpen = !!open[p.id];
            return (
              <Card key={p.id} className="p-5">
                <div className="text-body font-medium">{p.title}</div>
                {p.money_line && <div className="mt-0.5 text-small text-neutral-900">{p.money_line}</div>}
                {hasDetail && (
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
                    aria-expanded={isOpen}
                    className="mt-2 inline-flex items-center gap-1 text-small underline underline-offset-2"
                  >
                    What exactly changes
                    <ChevronDown size={14} className={clsx('transition-transform duration-150', isOpen && 'rotate-180')} aria-hidden />
                  </button>
                )}
                {isOpen && <Detail p={p} />}
                <div className="mt-4 flex gap-3">
                  <Button onClick={() => act('approve', p.id)} disabled={busy === p.id} className="!px-5 !py-2.5">
                    Approve
                  </Button>
                  <Button variant="secondary" onClick={() => act('dismiss', p.id)} disabled={busy === p.id} className="!px-5 !py-2.5">
                    Not this one
                  </Button>
                </div>
              </Card>
            );
          })}
          <p className="mt-2 text-tiny text-neutral-900">Every approved fix is applied, watched for 48 hours, and reversible with one tap from your history.</p>
        </div>
      )}

      <YourAds />
      <RequestComposer />
    </div>
  );
}
