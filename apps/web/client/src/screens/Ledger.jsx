// The ledger — §11. Everything we ever did, newest first, plain language.
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Undo2, FileText, Link2, Eye, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import { MonoLabel, Card, Spinner, EmptyState, ErrorNote, Button } from '../lib/ui.jsx';

const EVENT_ICON = {
  change_applied: CheckCircle2, tag_verified: CheckCircle2, approval: CheckCircle2,
  change_reverted: Undo2, revert_requested: Undo2,
  report_sent: FileText, connection_changed: Link2,
  watch_triggered: Eye, subscription_changed: FileText,
};

export default function Ledger() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/app/ledger').then((d) => setEntries(d.entries)).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!entries) return <Spinner label="Loading your ledger" />;

  async function requestRevert(targetId) {
    try { await api(`/api/app/revert/${targetId}`, { method: 'POST' }); } catch { /* surfaced via reload */ }
  }

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Every action, on the record</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Ledger</h1>

      {entries.length === 0 ? (
        <div className="mt-6"><EmptyState title="Nothing here yet" body="Once your first check runs, every action lands here — permanently." /></div>
      ) : (
        <Card className="mt-6 divide-y divide-neutral-200">
          {entries.map((e) => {
            const IconEl = EVENT_ICON[e.event] || AlertTriangle;
            const canRevert = e.event === 'change_applied';
            return (
              <div key={e.id} className="flex items-start gap-3 p-4">
                <IconEl size={16} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-small">{e.summary_text}</div>
                  <div className="mt-0.5 font-mono text-tiny text-neutral-900">
                    {new Date(e.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ·{' '}
                    {e.actor === 'user' ? 'you' : 'Insyt'}
                  </div>
                </div>
                {canRevert && (
                  <Button variant="ghost" onClick={() => requestRevert(e.id)} className="!px-2 !py-1 text-tiny">
                    Undo
                  </Button>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
