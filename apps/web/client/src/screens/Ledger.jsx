// History - §11. The past, in one place: every action ever taken (Activity)
// and every report ever sent (Reports), as two lenses on one screen. Both
// old routes (/app/ledger, /app/reports) deep-link into their lens.
import React, { useEffect, useState } from 'react';
import { CheckCircle as CheckCircle2, FlipBackward as Undo2, File02 as FileText, Link01 as Link2, Eye, AlertTriangle, ArrowRight, Lock01 as Lock } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { useAccess } from '../lib/access.jsx';
import { MonoLabel, Card, Spinner, EmptyState, ErrorNote, Button, Segments } from '../lib/ui.jsx';

const EVENT_ICON = {
  change_applied: CheckCircle2, fix_applied: CheckCircle2, tag_verified: CheckCircle2, approval: CheckCircle2,
  change_reverted: Undo2, fix_reverted: Undo2, revert_requested: Undo2, fix_proposed: FileText,
  report_sent: FileText, connection_changed: Link2,
  watch_triggered: Eye, subscription_changed: FileText,
  change_requested: FileText, fix_failed: AlertTriangle, exception_added: Lock,
};

const TYPE_LABEL = { weekly: 'Weekly report', audit: 'Your audit', signup: 'Your audit', deep: 'Deep review', monthly: 'Monthly pulse' };
const APPLIED = new Set(['fix_applied', 'change_applied', 'autopilot_applied']);
const FAILED = new Set(['fix_failed']);
const UNDONE = new Set(['fix_reverted', 'change_reverted', 'auto_reverted']);
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// The receipt under an applied fix (richer-platform spec §5): what the watch
// measured, in one line. Reverts say why.
function receiptLine(r) {
  if (!r) return null;
  if (r.state === 'verified') return `Verified${r.verified_at ? ` ${shortDate(r.verified_at)}` : ''}: ${r.line || 'the numbers held after the change'}`;
  if (r.state === 'inconclusive') return `Checked${r.verified_at ? ` ${shortDate(r.verified_at)}` : ''}: ${r.line || 'too early to tell, watching the next run'}`;
  if (r.state === 'reverted') return `Put back${r.line ? `: ${r.line}` : ''}`;
  if (r.state === 'failed') return null; // the row itself says why
  return r.watch_until ? `Watching until ${shortDate(r.watch_until)}` : 'Watching';
}

// The month in one line (spec §5): applied, verified, undone, recovered.
function MonthLine({ entries, receipts, money }) {
  const now = new Date();
  const ym = now.toISOString().slice(0, 7);
  const inMonth = entries.filter((e) => String(e.created_at || '').slice(0, 7) === ym);
  const applied = inMonth.filter((e) => APPLIED.has(e.event));
  if (!applied.length) return null;
  const verified = applied.filter((e) => e.change_id && receipts[e.change_id] && receipts[e.change_id].state === 'verified').length;
  const undone = inMonth.filter((e) => UNDONE.has(e.event)).length;
  const recovered = Math.round(applied.reduce((s, e) => s + Number(e.money_impact_usd || 0), 0));
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <p className="text-small text-neutral-900">
        <span className="font-medium text-strong">{now.toLocaleDateString('en-GB', { month: 'long' })}:</span>{' '}
        {applied.length} fix{applied.length === 1 ? '' : 'es'} applied, {verified} verified, {undone} undone{recovered > 0 ? `, about ${money(recovered)} a month recovered` : ''}.
      </p>
      <button type="button" onClick={() => window.print()} className="print:hidden text-tiny text-neutral-900 underline underline-offset-2">Print this month</button>
    </div>
  );
}

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
  const [receipts, setReceipts] = useState({});
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // { changeId, title, then_line, now_line }
  const { access, level, gate, money, version } = useAccess();
  useEffect(() => { api('/api/app/ledger').then((d) => { setEntries(d.entries); setPending(d.pending || []); setReceipts(d.receipts || {}); }).catch((e) => setError(e.message)); }, [version]);

  if (error) return <ErrorNote message={error} />;
  if (!entries) return <Spinner label="Loading your history" />;

  // Undo is a revert of the CHANGE (server: /api/app/revert/:changeId), not of
  // the ledger row. The executor logs applied fixes as `fix_applied`. Like a
  // yes, an undo writes to Google Ads, so it needs a plan (a lapsed plan opens
  // the sheet instead of failing).
  async function requestRevert(changeId, title) {
    // Eyes open (fix plan move 9): show the then and the now before undoing.
    if (!preview || preview.changeId !== changeId) {
      try {
        const p = await api(`/api/app/revert-preview/${changeId}`);
        setPreview({ changeId, title, then_line: p.then_line, now_line: p.now_line });
        return;
      } catch { /* no preview: undo straight away, as before */ }
    }
    setPreview(null);
    const run = async () => {
      await api(`/api/app/revert/${changeId}`, { method: 'POST' });
      const d = await api('/api/app/ledger');
      setEntries(d.entries);
      setReceipts(d.receipts || {});
    };
    try { await gate(run, { kind: 'revert', id: changeId, title: title ? `Undo: ${title}` : 'Undo this change' }); } catch (err) { setError(err.message); }
  }
  // Retry a fix Google refused (needs a plan, like any write).
  async function retry(changeId, title) {
    const run = async () => {
      await api(`/api/app/retry/${changeId}`, { method: 'POST' });
      const d = await api('/api/app/ledger');
      setEntries(d.entries);
      setReceipts(d.receipts || {});
    };
    try { await gate(run, { kind: 'retry', id: changeId, title: title || 'Retry this fix' }); } catch (err) { setError(err.message); }
  }

  const applied = entries.some((e) => e.event === 'fix_applied' || e.event === 'change_applied');
  if (entries.length === 0 || (!applied && pending.length)) {
    return (
      <div className="flex flex-col gap-6">
        {pending.length ? <FirstWeekPreview pending={pending} level={level} money={money} access={access} /> : (
          <EmptyState title="Nothing here yet" body="Once your first check runs, every action lands here - permanently." />
        )}
        {entries.length > 0 && <ActivityList entries={entries} receipts={receipts} requestRevert={requestRevert} retry={retry} preview={preview} cancelPreview={() => setPreview(null)} />}
      </div>
    );
  }
  return (
    <div>
      <MonthLine entries={entries} receipts={receipts} money={money} />
      <ActivityList entries={entries} receipts={receipts} requestRevert={requestRevert} retry={retry} preview={preview} cancelPreview={() => setPreview(null)} />
    </div>
  );
}

function ActivityList({ entries, receipts = {}, requestRevert, retry = null, preview = null, cancelPreview = null }) {
  const { access } = useAccess();
  const viewer = !!(access && access.role === 'viewer');
  const reverted = new Set(entries.filter((e) => e.event === 'fix_reverted' && e.change_id).map((e) => e.change_id));
  return (
    <Card className="divide-y divide-neutral-200">
      {entries.map((e) => {
        const IconEl = EVENT_ICON[e.event] || AlertTriangle;
        if (preview && preview.changeId === e.change_id && APPLIED.has(e.event)) {
          return (
            <div key={e.id} className="p-4">
              <div className="text-small">{e.summary_text}</div>
              <div className="mt-2 rounded border border-neutral-300 bg-neutral-50 p-3 text-small">
                <div>{preview.then_line}</div>
                {preview.now_line && <div className="mt-1 text-neutral-900">{preview.now_line}</div>}
                <div className="mt-3 flex gap-2">
                  <Button onClick={() => requestRevert(e.change_id, e.summary_text)} className="!px-4 !py-2">Undo it</Button>
                  <Button variant="secondary" onClick={cancelPreview} className="!px-4 !py-2">Keep it</Button>
                </div>
              </div>
            </div>
          );
        }
        const canRevert = e.event === 'fix_applied' && e.change_id && !reverted.has(e.change_id) && !viewer;
        const r = e.change_id && (APPLIED.has(e.event) || UNDONE.has(e.event)) ? receipts[e.change_id] : null;
        const receipt = r ? (UNDONE.has(e.event) ? (r.line ? `Why: ${r.line}` : null) : receiptLine(r)) : null;
        const receiptTone = r && r.state === 'verified' && !UNDONE.has(e.event) ? 'text-success' : r && r.state === 'reverted' ? 'text-warning' : 'text-neutral-900';
        return (
          <div key={e.id} className="flex items-start gap-3 p-4">
            <IconEl size={16} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-small">{e.summary_text}</div>
              {receipt && <div className={`mt-1 text-small ${receiptTone}`}>{receipt}</div>}
              <div className="mt-0.5 font-mono text-tiny text-neutral-900">
                {new Date(e.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ·{' '}
                {e.actor === 'user' ? 'you' : 'Insyt'}
              </div>
            </div>
            {canRevert && !(preview && preview.changeId === e.change_id) && (
              <Button variant="ghost" onClick={() => requestRevert(e.change_id, e.summary_text)} className="!px-2 !py-1 text-tiny">
                Undo
              </Button>
            )}
            {FAILED.has(e.event) && e.change_id && retry && !viewer && (
              <Button variant="ghost" onClick={() => retry(e.change_id, e.summary_text)} className="!px-2 !py-1 text-tiny">
                Retry
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
  const { money, level } = useAccess();
  useEffect(() => { api('/api/app/reports').then((d) => setReports(d.reports)).catch((e) => setError(e.message)); }, []);

  if (error) return <ErrorNote message={error} />;
  if (!reports) return <Spinner label="Loading reports" />;

  if (reports.length === 0) {
    return <EmptyState title="Your first report is on its way" body="Reports land here every week - and stay here." />;
  }
  return (
    <div>
      {level === 'locked' && reports.length > 1 && <p className="mb-3 text-small text-neutral-900">Unlock once and every report opens, this one and every one after.</p>}
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
          {r.summary && (r.summary.health_score != null || r.summary.waste_monthly_usd != null) && (
            <div className="shrink-0 text-right">
              {r.summary.health_score != null && <div className="text-small font-medium">Health {Math.round(r.summary.health_score)}</div>}
              {r.summary.waste_monthly_usd != null && (
                <div className={`text-tiny ${Number(r.summary.waste_monthly_usd) > 0 ? 'text-critical' : 'text-neutral-900'}`}>{money(Math.round(r.summary.waste_monthly_usd))}/mo waste</div>
              )}
            </div>
          )}
          <ArrowRight size={15} className="shrink-0 text-neutral-800" aria-hidden />
        </Link>
      ))}
    </Card>
    </div>
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
