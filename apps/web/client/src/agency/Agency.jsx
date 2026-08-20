// Agency console — master §13. Portfolio grid, triage queue, report review,
// brand kit, seats. Register inverts here: full technical vocabulary (this
// tree is exempt from the customer jargon lint). Binding rule everywhere:
// no auto-apply, no auto-publish — every action is an explicit seat click.

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  LayoutGrid, ListChecks, FileCheck2, Palette, Users, ArrowRight, Undo2, Copy, Check, X, Zap,
} from 'lucide-react';
import { api, isDemo, demoHref } from '../lib/api.js';
import { RouterProvider, useRouter, Link } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote, useCountUp } from '../lib/ui.jsx';

const NAV = [
  { to: '/app/agency', label: 'Portfolio', icon: LayoutGrid },
  { to: '/app/agency/triage', label: 'Triage', icon: ListChecks },
  { to: '/app/agency/review', label: 'Review', icon: FileCheck2 },
  { to: '/app/agency/brand', label: 'Brand', icon: Palette },
  { to: '/app/agency/seats', label: 'Seats', icon: Users },
];

const SEV = { critical: 'critical', warning: 'warning', info: 'info' };

function useAgency(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api(path).then(setData).catch((e) => setError(e)); }, [path]);
  return { data, error };
}

// ---------------------------------------------------------------- portfolio

function HealthPill({ score }) {
  const tone = score < 50 ? 'bg-critical-tint text-critical' : score < 70 ? 'bg-warning-tint text-warning' : 'bg-success-tint text-success';
  return <span className={clsx('rounded-full px-2.5 py-0.5 font-mono text-tiny font-semibold', tone)}>{score}</span>;
}

function Portfolio() {
  const { data, error } = useAgency('/api/agency/portfolio');
  const { data: credits } = useAgency('/api/agency/credits');
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading portfolio" />;
  const accounts = data.accounts || [];
  const attention = accounts.filter((a) => a.critical > 0 || a.pending_changes > 0).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <MonoLabel>Portfolio</MonoLabel>
          <h1 className="mt-1 text-h3 tracking-tight">{accounts.length} accounts · {attention} need attention</h1>
        </div>
        {credits && (
          <div className="flex items-center gap-2 rounded border border-neutral-300 bg-white px-3 py-2 text-small">
            <Zap size={14} className="text-info" aria-hidden />
            <span className="font-semibold">{credits.balance}</span> audit credits
            <span className="text-neutral-900">— run a white-labelled prospect audit to pitch a new client</span>
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((a, i) => (
          <Card key={a.id} className="rise lift flex flex-col gap-3 p-4" style={{ '--rise-i': Math.min(i, 8) }}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-body font-semibold">{a.name}</div>
                <div className="mt-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">
                  {a.manager || 'Unassigned'} · {a.register}{a.brief_only ? ' · brief-only' : ''}
                </div>
              </div>
              <HealthPill score={a.health} />
            </div>
            <div className="flex items-center gap-4 text-small text-neutral-900">
              <span><strong className={a.critical ? 'text-critical' : 'text-accent'}>{a.critical}</strong> critical</span>
              <span><strong className="text-accent">{a.open_findings}</strong> open</span>
              <span><strong className={a.pending_changes ? 'text-warning' : 'text-accent'}>{a.pending_changes}</strong> pending</span>
              {a.reports_awaiting_review > 0 && <span className="text-info">{a.reports_awaiting_review} report to review</span>}
            </div>
            <div className="flex items-center justify-between border-t border-neutral-200 pt-2.5 text-tiny text-neutral-900">
              <span>Last report {a.last_report_at ? new Date(a.last_report_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}</span>
              <Link to={demoHref('/app/agency/triage')} className="inline-flex items-center gap-1 underline underline-offset-2">
                Triage <ArrowRight size={12} aria-hidden />
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- triage

function DiffLine({ label, value }) {
  if (!value) return null;
  return (
    <div className="min-w-0 flex-1">
      <MonoLabel>{label}</MonoLabel>
      <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2.5 font-mono text-tiny leading-relaxed text-neutral-900">{JSON.stringify(value, null, 1)}</pre>
    </div>
  );
}

function TriageItem({ item, index, onDone }) {
  const [state, setState] = useState(null); // null | approved | dismissed | copied
  const [busy, setBusy] = useState(false);

  async function act(kind) {
    setBusy(true);
    try {
      await api(`/api/agency/${kind}/${item.id}`, { method: 'POST', body: kind === 'dismiss' ? { reason: 'dismissed from triage' } : {} });
      setState(kind === 'approve' ? 'approved' : 'dismissed');
      onDone();
    } catch (e) { setState(null); }
    setBusy(false);
  }
  function copyBrief() {
    const brief = [
      `${item.account} — ${item.title}`,
      `Rule ${item.rule_id} (layer ${item.layer}) · ${item.severity}${item.money_monthly_usd ? ` · ~$${item.money_monthly_usd}/mo` : ''}`,
      '', item.explanation, '',
      `BEFORE: ${JSON.stringify(item.before)}`, `AFTER:  ${JSON.stringify(item.after)}`,
    ].join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(brief).catch(() => {});
    setState('copied');
    setTimeout(() => setState((s) => (s === 'copied' ? null : s)), 1600);
  }

  if (state === 'approved' || state === 'dismissed') {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        {state === 'approved' ? <Check size={15} className="text-success" aria-hidden /> : <X size={15} className="text-neutral-900" aria-hidden />}
        {item.account}: {state === 'approved' ? 'approved — executor will apply and verify' : 'dismissed with reason'} · logged to the audit trail
      </Card>
    );
  }

  return (
    <Card accent={SEV[item.severity] || 'info'} className="rise p-4" style={{ '--rise-i': Math.min(index, 8) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">{item.account}</span>
          <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">{item.rule_id} · L{item.layer}</span>
        </div>
        {item.money_monthly_usd && <span className="text-small font-semibold">~${item.money_monthly_usd}/mo</span>}
      </div>
      <h3 className="mt-2 text-h5">{item.title}</h3>
      <p className="mt-1 text-small text-neutral-900">{item.explanation}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <DiffLine label="Before" value={item.before} />
        <DiffLine label="After" value={item.after} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3">
        {!item.brief_only && (
          <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Apply</Button>
        )}
        <Button variant="secondary" onClick={copyBrief} className="!px-4 !py-2">
          <Copy size={13} aria-hidden /> {state === 'copied' ? 'Copied' : 'Copy fix brief'}
        </Button>
        <Button variant="ghost" onClick={() => act('dismiss')} disabled={busy} className="!py-2">Dismiss with reason</Button>
        {item.brief_only && <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">brief-only account — Apply disabled</span>}
      </div>
    </Card>
  );
}

function Triage() {
  const { data, error } = useAgency('/api/agency/triage');
  const [, force] = useState(0);
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading triage queue" />;
  const queue = data.queue || [];
  return (
    <div>
      <MonoLabel>Triage</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{queue.length} proposed changes, biggest money first</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
        Every change ships both ways: Apply (our executor runs it through the staged workspace → diff → publish → verify path) or Copy fix brief for manual execution. Nothing is ever auto-applied. Every decision here lands in the per-seat audit log.
      </p>
      {queue.length === 0 ? (
        <div className="mt-5"><EmptyState title="Queue is clear" body="New findings from the weekly runs land here across every account." /></div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {queue.map((item, i) => <TriageItem key={item.id} item={item} index={i} onDone={() => force((n) => n + 1)} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- review queue

function ReviewItem({ r }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  async function act(kind) {
    setBusy(true);
    try {
      await api(`/api/agency/report/${r.id}/${kind}`, { method: 'POST', body: kind === 'reject' ? { reason: 'needs edits' } : {} });
      setState(kind);
    } catch { /* keep row */ }
    setBusy(false);
  }
  if (state) {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        {state === 'approve' ? <Check size={15} className="text-success" aria-hidden /> : <X size={15} aria-hidden />}
        {r.account}: report {state === 'approve' ? 'approved — now visible in the client library' : 'sent back'}
      </Card>
    );
  }
  return (
    <Card className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-body font-semibold">{r.account}</div>
        <div className="mt-0.5 text-small text-neutral-900">
          {r.type === 'deep' ? 'Deep audit' : 'Weekly report'} · rendered {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · white-labelled PDF + web view
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <a href={demoHref('/app/report')} className="inline-flex items-center gap-1.5 rounded border border-neutral-500 bg-white px-4 py-2 text-small font-medium">Preview</a>
        <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Approve</Button>
        <Button variant="ghost" onClick={() => act('reject')} disabled={busy} className="!py-2">Send back</Button>
      </div>
    </Card>
  );
}

function Review() {
  const { data, error } = useAgency('/api/agency/review');
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading review queue" />;
  const queue = data.queue || [];
  return (
    <div>
      <MonoLabel>Report review</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{queue.length} awaiting sign-off</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
        The platform never emails your clients. Reports render into this queue; nothing becomes client-visible until a seat approves it. You distribute however you like.
      </p>
      {queue.length === 0 ? (
        <div className="mt-5"><EmptyState title="Nothing waiting" body="Weekly renders land here after each run." /></div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">{queue.map((r) => <ReviewItem key={r.id} r={r} />)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- brand kit

function Brand() {
  const { data, error } = useAgency('/api/agency/brand');
  const [kit, setKit] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setKit(data.kit || { display_name: '', color_primary: '#0B1F2A', color_accent: '#E07A3F', footer_text: '' }); }, [data]);
  if (error) return <ErrorNote message={error.message} />;
  if (!kit) return <Spinner label="Loading brand kit" />;

  async function save() {
    setBusy(true); setSaved(null);
    try {
      const r = await api('/api/agency/brand', { method: 'POST', body: kit });
      setSaved(r.version ? `Saved as version ${r.version}. Earlier reports keep the version they shipped with.` : 'Saved.');
    } catch (e) { setSaved(e.message); }
    setBusy(false);
  }
  const field = (label, key, type = 'text') => (
    <label className="block">
      <MonoLabel>{label}</MonoLabel>
      <input
        type={type}
        value={kit[key] || ''}
        onChange={(e) => setKit({ ...kit, [key]: e.target.value })}
        className={clsx('mt-1 w-full rounded border border-neutral-500 bg-white px-3 py-2.5 text-small outline-none focus:border-accent', type === 'color' && 'h-11 p-1')}
      />
    </label>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <MonoLabel>Brand kit {kit.version ? `· v${kit.version}` : ''}</MonoLabel>
        <h1 className="mt-1 text-h3 tracking-tight">Your reports, your name on them</h1>
        <p className="mt-1 text-small text-neutral-900">Versioned — a rebrand never alters reports already in client hands.</p>
        <div className="mt-5 flex flex-col gap-4">
          {field('Report display name', 'display_name')}
          <div className="grid grid-cols-2 gap-4">
            {field('Primary colour', 'color_primary', 'color')}
            {field('Accent colour', 'color_accent', 'color')}
          </div>
          {field('Logo URL (light backgrounds)', 'logo_light_url')}
          {field('Footer line', 'footer_text')}
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save new version'}</Button>
            {saved && <span className="text-small text-success">{saved}</span>}
          </div>
        </div>
      </div>
      <div>
        <MonoLabel>Live preview</MonoLabel>
        <div className="mt-1 overflow-hidden rounded border border-neutral-300 bg-white">
          <div className="flex items-center justify-between px-5 py-4" style={{ background: kit.color_primary || '#0B1F2A' }}>
            <span className="text-h5 font-semibold text-white">{kit.display_name || 'Your agency'}</span>
            <span className="font-mono text-tiny uppercase tracking-[0.12em] text-white/70">Weekly report</span>
          </div>
          <div className="p-5">
            <div className="text-h4">Glow Studio — 7 findings, biggest money first</div>
            <div className="mt-2 h-2 w-40 rounded-full" style={{ background: kit.color_accent || '#E07A3F' }} />
            <p className="mt-3 text-small text-neutral-900">Dual primary conversion actions are double-counting purchases…</p>
            <div className="mt-5 border-t border-neutral-200 pt-3 text-tiny text-neutral-900">{kit.footer_text || 'Footer line appears here'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- seats

function Seats() {
  const { data, error } = useAgency('/api/agency/seats');
  const { data: log } = useAgency('/api/agency/log');
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading seats" />;
  const roleLabel = { admin: 'Admin — billing, brand, seats, all accounts', am: 'Account manager — scoped to assigned accounts', readonly: 'Read-only' };
  return (
    <div>
      <MonoLabel>Seats &amp; roles</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{data.seats.length} seats</h1>
      <div className="mt-5 flex flex-col gap-2">
        {data.seats.map((s) => (
          <Card key={s.id} className="flex flex-col items-start gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-body font-medium">{s.name || s.email} {s.status === 'invited' && <span className="ml-1 rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">invited</span>}</div>
              <div className="text-small text-neutral-900">{s.email}</div>
            </div>
            <div className="text-small text-neutral-900">{roleLabel[s.role] || s.role}</div>
          </Card>
        ))}
      </div>
      {log && (
        <div className="mt-8">
          <MonoLabel>Per-seat audit trail</MonoLabel>
          <div className="mt-2 overflow-hidden rounded border border-neutral-300 bg-white">
            {log.entries.map((e, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-2.5 text-small last:border-0">
                <span><strong>{e.seat ? e.seat.name : 'system'}</strong> · {e.event.replace(/_/g, ' ')}{e.detail && e.detail.reason ? ` — “${e.detail.reason}”` : ''}</span>
                <span className="shrink-0 font-mono text-tiny text-neutral-900">{new Date(e.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-tiny text-neutral-900">Every approval, dismissal and report sign-off, by whom, forever. Your record if a client ever asks.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shell

function AgencyRoutes() {
  const { path } = useRouter();
  const { data: me, error } = useAgency('/api/agency/me');

  let screen = <Portfolio />;
  if (path === '/app/agency/triage') screen = <Triage />;
  if (path === '/app/agency/review') screen = <Review />;
  if (path === '/app/agency/brand') screen = <Brand />;
  if (path === '/app/agency/seats') screen = <Seats />;

  if (error && error.status === 401 && !isDemo()) {
    return (
      <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
        <MonoLabel>Insyt for agencies</MonoLabel>
        <h1 className="mt-2 text-h2 tracking-tight">Sign in</h1>
        <div className="mt-6"><Button href="/auth/google/start?step=discovery">Continue with Google</Button></div>
      </div>
    );
  }
  if (error && error.status === 403 && !isDemo()) {
    return (
      <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
        <h1 className="text-h3">This sign-in has no agency seat.</h1>
        <p className="mt-2 text-small text-neutral-900">Ask your agency admin for an invite, or contact us to set up your agency.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-neutral-300 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-xl2 items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <Link to={demoHref('/app/agency')} className="text-h5 font-semibold tracking-tight">Insyt</Link>
            <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">Agency</span>
            {me && me.agency && <span className="hidden text-small text-neutral-900 sm:inline">{me.agency.name}</span>}
          </div>
          {isDemo() && <MonoLabel>Preview with sample data</MonoLabel>}
        </div>
        <nav className="mx-auto flex max-w-xl2 gap-1 overflow-x-auto px-3 pb-2" aria-label="Agency">
          {NAV.map(({ to, label, icon: IconEl }) => {
            const active = path === to;
            return (
              <Link
                key={to}
                to={demoHref(to)}
                className={clsx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-small font-medium',
                  active ? 'bg-accent text-white' : 'text-neutral-900 hover:bg-neutral-100',
                )}
              >
                <IconEl size={14} aria-hidden /> {label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-xl2 px-5 pb-24 pt-8">{screen}</main>
      <footer className="mx-auto max-w-xl2 px-5 pb-10 text-tiny text-neutral-900">
        <Undo2 size={12} className="mr-1 inline" aria-hidden />
        No auto-apply, ever. Changes land on client accounts under your name — every one waits for a seat&apos;s explicit approval, and every applied change keeps a one-tap rollback.
      </footer>
    </div>
  );
}

export default function Agency() {
  return <AgencyRoutes />;
}
