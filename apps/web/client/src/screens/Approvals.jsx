// Approvals queue - §11. One card per waiting fix; approve or dismiss.
import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote } from '../lib/ui.jsx';

export default function Approvals() {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

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
          {pending.map((p) => (
            <Card key={p.id} className="p-5">
              <div className="text-body font-medium">{p.title}</div>
              {p.money_line && <div className="mt-0.5 text-small text-neutral-900">{p.money_line}</div>}
              <div className="mt-4 flex gap-3">
                <Button onClick={() => act('approve', p.id)} disabled={busy === p.id} className="!px-5 !py-2.5">
                  Approve
                </Button>
                <Button variant="secondary" onClick={() => act('dismiss', p.id)} disabled={busy === p.id} className="!px-5 !py-2.5">
                  Not this one
                </Button>
              </div>
            </Card>
          ))}
          <p className="mt-2 text-tiny text-neutral-900">Every approved fix is applied, watched for 48 hours, and reversible with one tap from your ledger.</p>
        </div>
      )}
    </div>
  );
}
