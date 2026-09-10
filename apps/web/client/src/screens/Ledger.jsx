// History - §11. The past, in one place: every action ever taken (Activity)
// and every report ever sent (Reports), as two lenses on one screen. Both
// old routes (/app/ledger, /app/reports) deep-link into their lens.
import React, { useEffect, useState } from 'react';
import { CheckCircle as CheckCircle2, FlipBackward as Undo2, File02 as FileText, Link01 as Link2, Eye, AlertTriangle, ArrowRight } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { useAccess } from '../lib/access.jsx';
import { MonoLabel, Card, Spinner, EmptyState, ErrorNote, Button, Segments } from '../lib/ui.jsx';

const EVENT_ICON = {
  change_applied: CheckCircle2, fix_applied: CheckCircle2, tag_verified: CheckCircle2, approval: CheckCircle2,
  change_reverted: Undo2, fix_reverted: Undo2, revert_requested: Undo2, fix_proposed: FileText,
  report_sent: FileText, connection_changed: Link2,
  watch_triggered: Eye, subscription_changed: FileText,
  change_requested: FileText,
};

const TYPE_LABEL = { weekly: 'Weekly report', audit: 'Your audit', deep: 'Deep review', monthly: 'Monthly pulse' };

// Next Sunday, when the weekly check runs and approved fixes go out.
function nextSunday() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Before any fix has been applied, History shows what the first week looks
// like: the queued fixes, greyed, dated for the coming Sunday (spec §4).
function FirstWeekPreview({ pending, level, money, access }) {
  if (!pending || !pending.length) return null;
  const locked = level === 'locked';
  return (
    <div>
      <MonoLabel>What your first week looks like</MonoLabel>
      <Card className="mt-2 divide-y divide-neutral-200 opacity-80">
        {pending.map((p) => (
          <div key={p.id} className="flex items-start gap-3 p-4">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-neutral-800" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-small">{p.title}{!locked && p.money_line ? <span className="text-neutral-900">, {p.money_line}</span> : null}</div>
              <div className="mt-0.5 font-mono text-tiny text-neutral-900">{nextSunday()} · applied after your yes · Undo for 30 days</div>
            </div>
          </div>
        ))}
      </Card>
      <p className="mt-2 text-tiny text-neutral-900">
        {level === 'active' ? 'Approve them from Approvals; each one lands here with a one-tap Undo.'
          : locked ? 'Money lines open with the full report. Fixes you approve land here with a one-tap Undo.'
            : `Fixes you approve land here with a one-tap Undo.${access && access.pending_value_usd > 0 ? ` Together these are worth about ${money(access.pending_value_usd)} a month.` : ''}`}
      </p>
    </div>
  );
}

function Activity() {
  const [entries, setEntries] = useState(null);
  const [pending, setPending] = useState([]);
  const [error, setError] = useState(null);
  const { access, level, gate, money, version } = useAccess();
  useEffect(() => { api('/api/app/ledger').then((d) => { setEntries(d.entries); setPending(d.pending || []); }).catch((e) => setError(e.message)); }, [version]);

  if (error) return <ErrorNote message={error} />;
  if (!entries) return <Spinner label="Loading your history" />;

  // Undo is a revert of the CHANGE (server: /api/app/revert/:changeId), not of
  // the ledger row. The executor logs applied fixes as `fix_applied`. Like a
  // yes, an undo writes to Google Ads, so it needs a plan (a lapsed plan opens
  // the sheet instead of failing).
  async function requestRevert(changeId, title) {
    const run = async () => {
      await api(`/api/app/revert/${changeId}`, { method: 'POST' });
      const d = await api('/api/app/ledger');
      setEntries(d.entries);
    };
    try { await gate(run, { kind: 'revert', id: changeId, title: title ? `Undo: ${title}` : 'Undo this change' }); } catch (err) { setError(err.message); }
  }

  const applied = entries.some((e) => e.event === 'fix_applied' || e.event === 'change_applied');
  if (entries.length === 0 || (!applied && pending.length)) {
    return (
      <div className="flex flex-col gap-6">
        {pending.length ? <FirstWeekPreview pending={pending} level={level} money={money} access={access} /> : (
          <EmptyState title="Nothing here yet" body="Once your first check runs, every action lands here - permanently." />
        )}
        {entries.length > 0 && <ActivityList entries={entries} requestRevert={requestRevert} />}
      </div>
    );
  }
  return <ActivityList entries={entries} requestRevert={requestRevert} />;
}

function ActivityList({ entries, requestRevert }) {
  const reverted = new Set(entries.filter((e) => e.event === 'fix_reverted' && e.change_id).map((e) => e.change_id));
  return (
    <Card className="divide-y divide-neutral-200">
      {entries.map((e) => {
        const IconEl = EVENT_ICON[e.event] || AlertTriangle;
        const canRevert = e.event === 'fix_applied' && e.change_id && !reverted.has(e.change_id);
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
              <Button variant="ghost" onClick={() => requestRevert(e.change_id, e.summary_text)} className="!px-2 !py-1 text-tiny">
                Undo
              </Button>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function ReportList() {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/app/reports').then((d) => setReports(d.reports)).catch((e) => setError(e.message)); }, []);

  if (error) return <ErrorNote message={error} />;
  if (!reports) return <Spinner label="Loading reports" />;

  if (reports.length === 0) {
    return <EmptyState title="Your first report is on its way" body="Reports land here every week - and stay here." />;
  }
  return (
    <Card className="divide-y divide-neutral-200">
      {reports.map((r) => (
        <Link key={r.id} to={`/app/report/${r.id}`} className="flex items-center gap-3 p-4 hover:bg-neutral-50">
          <FileText size={16} className="shrink-0 text-neutral-900" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium">{TYPE_LABEL[r.type] || r.type}</div>
            <div className="mt-0.5 font-mono text-tiny text-neutral-900">
              {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              {!r.viewed_at && <span className="ml-2 rounded-full bg-info-tint px-2 py-0.5 text-info">New</span>}
            </div>
          </div>
          <ArrowRight size={15} className="shrink-0 text-neutral-800" aria-hidden />
        </Link>
      ))}
    </Card>
  );
}

export default function History({ view = 'activity' }) {
  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>{view === 'reports' ? 'Your reports, kept forever' : 'Every action, on the record'}</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">History</h1>
      <div className="mt-4">
        <Segments
          items={[
            { label: 'Activity', to: '/app/ledger', active: view === 'activity' },
            { label: 'Reports', to: '/app/reports', active: view === 'reports' },
          ]}
        />
      </div>
      <div className="mt-5">{view === 'reports' ? <ReportList /> : <Activity />}</div>
    </div>
  );
}
