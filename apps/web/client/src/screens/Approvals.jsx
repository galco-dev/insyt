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
      await api(`/api/app/${kind}/${id}`, { method: 'POST' });
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

      <RequestComposer />
    </div>
  );
}
