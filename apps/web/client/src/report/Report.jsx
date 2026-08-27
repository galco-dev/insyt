// The Report - §11 screen 4, anatomy per frontend-strategy §6.
// Without a reportId: the full sample audit (public showcase + demo).
// With a reportId: the tenant's real report (findings snapshot from the API).
// Locked (pre-unlock) by default; ?unlocked=1 shows everything.

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { LineChart, StackedBarsH, Histogram, HourProfile, ShareBars } from './charts.jsx';
import { CheckCircle as CheckCircle2, AlertTriangle, Lock01 as Lock, ArrowRight, FlipBackward as Undo2, Eye } from '@untitledui/icons';
import { audit, deep } from './data.js';
import { api, isDemo } from '../lib/api.js';
import {
  COLOR, MonoLabel, SeverityBadge, severityMeta, verdictMeta, Spinner, ErrorNote, EmptyState,
} from '../lib/ui.jsx';

function VerdictChip({ verdict }) {
  const m = verdictMeta[verdict.v];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={clsx('h-1.5 w-1.5 rounded-full', COLOR[m.color].bg)} aria-hidden />
      <span className="text-small font-medium">{m.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------- health dial

export function HealthDial({ score, label }) {
  const sevColor = score < 50 ? 'var(--ui-critical)' : score < 70 ? 'var(--ui-warning)' : 'var(--ui-success)';
  const r = 64;
  const cx = 80; const cy = 80;
  const start = 135; const sweepMax = 270;
  const sweep = (score / 100) * sweepMax;
  const arc = (from, deg) => {
    const rad = (a) => ((a - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(from)); const y1 = cy + r * Math.sin(rad(from));
    const x2 = cx + r * Math.cos(rad(from + deg)); const y2 = cy + r * Math.sin(rad(from + deg));
    return `M ${x1} ${y1} A ${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  return (
    <div className="relative h-[160px] w-[160px] shrink-0" role="img" aria-label={`Account health ${score} out of 100 - ${label}`}>
      <svg viewBox="0 0 160 160" className="h-full w-full">
        <path d={arc(start, sweepMax)} fill="none" strokeWidth="10" strokeLinecap="round" style={{ stroke: 'var(--ui-ring)' }} />
        <path d={arc(start, Math.max(sweep, 4))} fill="none" strokeWidth="10" strokeLinecap="round" style={{ stroke: sevColor }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[2.75rem] font-semibold leading-none tracking-tight">{score}</div>
        <div className="mt-1 font-mono text-tiny uppercase tracking-[0.12em] text-neutral-900">of 100</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- finding card

function FindingCard({ f, locked, index = 0 }) {
  const m = severityMeta[f.severity] || severityMeta.info;
  return (
    <div
      className={clsx('rise rounded border border-neutral-300 bg-card border-l-[3px]', COLOR[m.color].borderL)}
      style={{ '--rise-i': Math.min(index, 8) }}
    >
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <SeverityBadge severity={severityMeta[f.severity] ? f.severity : 'info'} />
          {f.money && <span className="text-small font-semibold">{f.money}</span>}
        </div>
        <h3 className="mt-2 text-h5">{f.title}</h3>
        <p className="mt-1.5 text-body text-neutral-900">{f.body}</p>
        {f.fix !== undefined && (
          <div className={clsx('mt-3 flex items-start gap-2 rounded-sm px-3 py-2.5', COLOR[m.color].tint)}>
            <ArrowRight size={15} strokeWidth={2.2} className={clsx('mt-0.5 shrink-0', COLOR[m.color].text)} aria-hidden />
            <p className={clsx('text-small font-medium', locked && 'blurred')} aria-hidden={locked || undefined}>
              {locked ? 'The exact fix is in the full report - one approval away.' : f.fix}
            </p>
            {locked && <Lock size={13} className="mt-0.5 shrink-0 text-neutral-900" aria-label="Unlocks with the full report" />}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- data table

function SectionHead({ kicker, title, count, locked }) {
  return (
    <div className="mt-12 mb-4 flex items-end justify-between gap-4">
      <div>
        <MonoLabel>{kicker}</MonoLabel>
        <h2 className="mt-1 text-h4">{title}</h2>
      </div>
      {count && (
        <span className="mb-0.5 inline-flex items-center gap-1.5 rounded-full border border-neutral-400 bg-(--ui-well) px-3 py-1 font-mono text-tiny text-neutral-900">
          {locked && <Lock size={11} aria-hidden />} {count}
        </span>
      )}
    </div>
  );
}

function DataTable({ spec, locked, clearRows = 3, renderCell }) {
  const rows = spec.rows;
  const hidden = spec.total ? spec.total - rows.length : 0;
  return (
    <div className="overflow-hidden rounded border border-neutral-300 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-small">
          <thead>
            <tr className="border-b border-neutral-300 bg-neutral-50">
              {spec.columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-tiny font-medium uppercase tracking-[0.1em] text-neutral-900">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const blur = locked && i >= clearRows;
              return (
                <tr key={i} className={clsx('border-b border-neutral-200 last:border-0', blur && 'blurred select-none')} aria-hidden={blur || undefined}>
                  {row.map((cell, j) => renderCell(cell, j, blur))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(locked || hidden > 0) && (
        <div className="flex items-center gap-2 border-t border-neutral-300 bg-neutral-50 px-4 py-2.5 font-mono text-tiny text-neutral-900">
          {locked ? <Lock size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
          {locked
            ? `${hidden > 0 ? `${hidden} more rows - ` : ''}every row and every verdict unlocks with the full report`
            : hidden > 0 ? `${hidden} more rows in the full data view` : null}
        </div>
      )}
    </div>
  );
}

function statCell(cell, j, key) {
  if (cell && typeof cell === 'object' && cell.v) {
    return (
      <td key={key} className="px-4 py-3 align-top">
        <VerdictChip verdict={cell} />
        <div className="mt-0.5 max-w-[260px] text-tiny leading-snug text-neutral-900">{cell.why}</div>
      </td>
    );
  }
  const numeric = typeof cell === 'number' || /^[$−+\-]?[\d,.]+%?$/.test(String(cell));
  return (
    <td key={key} className={clsx('whitespace-nowrap px-4 py-3 align-top', numeric && j > 0 ? 'text-right tabular-nums' : 'text-left', j === 0 && 'font-medium')}>
      {cell}
    </td>
  );
}

// ---------------------------------------------------------------- tracking table

function TrackingRow({ row, blur }) {
  const [check, status, detail] = row;
  const ok = status === 'ok';
  const IconEl = ok ? CheckCircle2 : AlertTriangle;
  return (
    <tr className={clsx('border-b border-neutral-200 last:border-0', blur && 'blurred select-none')} aria-hidden={blur || undefined}>
      <td className="whitespace-nowrap px-4 py-3 align-top font-medium">{check}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <span className={clsx('inline-flex items-center gap-1.5 font-mono text-tiny uppercase tracking-[0.1em]', ok ? 'text-success' : 'text-warning')}>
          <IconEl size={13} strokeWidth={2.4} aria-hidden /> {ok ? 'Working' : 'Gap'}
        </span>
      </td>
      <td className="px-4 py-3 align-top text-neutral-900">{detail}</td>
    </tr>
  );
}

// ---------------------------------------------------------------- unlock

function UnlockBar({ visible }) {
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!visible) return null;
  async function unlock() {
    setBusy(true); setNote(null);
    try {
      const r = await api('/api/checkout/audit', { method: 'POST', body: { kind: 'audit_unlock' } });
      if (r.url) { window.location.href = r.url; return; }
      setNote(isDemo() ? 'Demo mode - checkout opens here once payments are connected.' : 'Payments are almost ready - try again shortly.');
    } catch (e) { setNote(e.status === 401 ? 'Sign in first - run your free check from the start page.' : e.message); }
    setBusy(false);
  }
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-300 bg-page/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-l2 flex-col items-start gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-body font-semibold">{audit.unlock.line}</div>
          <div className="mt-0.5 text-small text-neutral-900">{note || audit.unlock.sub}</div>
        </div>
        <button
          type="button"
          onClick={unlock}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-2 rounded bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) px-6 py-3 text-small font-medium text-page ring-1 ring-inset ring-(--ui-cta-edge) shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_var(--ui-cta-hi)] disabled:opacity-40"
        >
          {busy ? 'Opening checkout…' : `Unlock for ${audit.unlock.price}`} <ArrowRight size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}


function ChartCard({ children }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-gradient-to-b from-card-hi to-card p-4 ring-1 ring-inset ring-(--ui-ring) sm:p-5">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- real report (findings snapshot)

const SNAPSHOT_SEV = { critical: 'critical', warning: 'warning', info: 'info', opportunity: 'info' };

function RealReport({ reportId }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api(`/api/app/report/${reportId}`).then((d) => setReport(d.report)).catch((e) => setError(e.message)); }, [reportId]);

  if (error) return <div className="mx-auto max-w-l2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!report) return <Spinner label="Loading your report" />;

  const locked = report.unlocked === false;
  const summary = report.summary || {};
  const ORDER = { critical: 0, warning: 1, opportunity: 2, info: 3 };
  const snapshot = (report.findings_snapshot || []).filter((f) => f.status !== 'dismissed' && f.status !== 'resolved');
  const findings = snapshot.map((f) => {
    const usd = f.money && f.money.impact_monthly_usd != null ? f.money.impact_monthly_usd : f.money_impact_monthly_usd;
    const p = f.payload || {};
    const entities = Array.isArray(p.entities) ? p.entities.length : 0;
    // Titles fall back to the rule name while narration is still being written.
    const title = f.title && !/^[a-z0-9]+ [a-z0-9 ]+$/.test(f.title) ? f.title : (f.title || '').replace(/^\w/, (c) => c.toUpperCase());
    return {
      id: f.finding_id || f.id || `${f.rule_id}:${f.entity_key || ''}`,
      severity: SNAPSHOT_SEV[f.severity] || 'info',
      rawSeverity: f.severity,
      title,
      campaign: f.campaign_name || null,
      money: usd ? `about $${Math.round(usd).toLocaleString()} / month` : null,
      usd: usd || 0,
      body: f.explanation || '',
      fix: p.fix_detail || (entities ? `${entities} item${entities === 1 ? '' : 's'} to fix - the full report lists each one.` : undefined),
      lockedFix: !!p.locked && locked,
    };
  }).sort((a, b) => (ORDER[a.rawSeverity] ?? 3) - (ORDER[b.rawSeverity] ?? 3) || b.usd - a.usd);

  const counts = summary.counts || snapshot.reduce((c, f) => ({ ...c, [f.severity]: (c[f.severity] || 0) + 1 }), {});
  const waste = summary.waste_monthly_usd != null ? Math.round(summary.waste_monthly_usd) : Math.round(findings.filter((f) => f.rawSeverity === 'warning' || f.rawSeverity === 'critical').reduce((s, f) => s + f.usd, 0));
  const health = summary.health_score != null ? Math.round(summary.health_score) : null;
  const healthLabel = health == null ? '' : health < 50 ? 'Needs work' : health < 70 ? 'Needs attention' : 'Healthy';
  const kicker = report.type === 'weekly' ? 'Weekly report' : report.type === 'deep' ? 'Deep review' : 'Your audit';
  const dateLabel = new Date(report.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const chips = [['critical', counts.critical || 0], ['warning', counts.warning || 0], ['info', (counts.info || 0) + (counts.opportunity || 0)]].filter(([, n]) => n > 0);

  return (
    <div className={clsx('pb-32', locked && 'locked')}>
      <main className="mx-auto max-w-l2 px-5">
        <section className="flex flex-col gap-8 pt-10 sm:flex-row sm:items-center">
          {health != null && <HealthDial score={health} label={healthLabel} />}
          <div>
            <MonoLabel>{kicker} · {dateLabel}</MonoLabel>
            <h1 className="mt-2 text-h2 tracking-tight">
              {findings.length === 0
                ? 'All clear this week.'
                : waste > 0
                  ? <>About <span className="text-critical">${waste.toLocaleString()} a month</span> is going to waste.</>
                  : `${findings.length} finding${findings.length === 1 ? '' : 's'}, biggest money first.`}
            </h1>
            <p className="mt-2 max-w-m2 text-body text-neutral-900">
              {summary.exec_summary || 'We checked your ads, your tracking and your counting, line by line.'}
              {health != null && <> Health score <strong>{health}/100 - {healthLabel.toLowerCase()}</strong>.</>}
            </p>
            {chips.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {chips.map(([sev, n]) => (
                  <span key={sev} className={clsx('inline-flex items-center gap-1.5 rounded-full px-3 py-1', COLOR[severityMeta[sev].color].tint)}>
                    <SeverityBadge severity={sev} />
                    <span className="text-small font-semibold">{n}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {findings.length === 0 ? (
          <div className="mt-8"><EmptyState title="Nothing needed your attention" body="We checked everything on schedule. The next report lands in a week." /></div>
        ) : (
          <>
            <SectionHead kicker="What we found" title={`${findings.length} finding${findings.length === 1 ? '' : 's'}, biggest money first`} />
            <div className="flex flex-col gap-3">
              {findings.map((f, i) => (
                <FindingCard key={f.id} index={i} locked={f.lockedFix} f={{ ...f, title: f.campaign ? `${f.title} - ${f.campaign}` : f.title }} />
              ))}
            </div>
          </>
        )}
        {summary.since_last_week && (
          <p className="mt-10 text-small text-neutral-900"><span className="font-mono text-tiny uppercase tracking-[0.12em]">Since last week</span> · {summary.since_last_week}</p>
        )}
      </main>
      <UnlockBar visible={locked} />
    </div>
  );
}

// ---------------------------------------------------------------- sample page

export default function Report({ reportId = null }) {
  if (reportId) return <RealReport reportId={reportId} />;
  const locked = !new URLSearchParams(window.location.search).get('unlocked');
  const chips = [
    ['critical', audit.counts.critical], ['warning', audit.counts.warning], ['info', audit.counts.info],
  ];

  return (
    <div className={clsx('pb-32', locked && 'locked')}>
      <main className="mx-auto max-w-l2 px-5">
        {/* hero */}
        <section className="flex flex-col gap-8 pt-10 sm:flex-row sm:items-center">
          <HealthDial score={audit.health} label={audit.healthLabel} />
          <div>
            <MonoLabel>{audit.business} · {audit.city} · {audit.site}</MonoLabel>
            <h1 className="mt-2 text-h2 tracking-tight">
              About <span className="text-critical">${audit.wasteMonthly.toLocaleString()} a month</span> is going to waste.
            </h1>
            <p className="mt-2 max-w-m2 text-body text-neutral-900">
              We checked your ads, your tracking and your counting - {audit.searchTerms.total} searches,{' '}
              {audit.keywords.total} keywords, {audit.campaigns.rows.length} campaigns, line by line. Health score{' '}
              <strong>{audit.health}/100 - {audit.healthLabel.toLowerCase()}</strong>.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {chips.map(([sev, n]) => (
                <span key={sev} className={clsx('inline-flex items-center gap-1.5 rounded-full px-3 py-1', COLOR[severityMeta[sev].color].tint)}>
                  <SeverityBadge severity={sev} />
                  <span className="text-small font-semibold">{n}</span>
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* findings */}
        <SectionHead kicker="What we found" title="Seven findings, biggest money first" />
        <div className="flex flex-col gap-3">
          {audit.findings.map((f, i) => <FindingCard key={f.title} f={f} locked={locked} index={i} />)}
        </div>

        {/* search terms */}
        <SectionHead kicker="Line by line · last 90 days" title="Every search your money bought" count={`${audit.searchTerms.total} searches`} locked={locked} />
        <DataTable spec={audit.searchTerms} locked={locked} renderCell={(c, j) => statCell(c, j, j)} />

        {/* keywords */}
        <SectionHead kicker={`Cost per booking · account average $${audit.keywords.accountAvgCpa}`} title="Keywords, judged one by one" count={`${audit.keywords.total} keywords`} locked={locked} />
        <DataTable spec={audit.keywords} locked={locked} renderCell={(c, j) => statCell(c, j, j)} />

        {/* campaigns */}
        <SectionHead kicker="Structure & budgets" title="Campaigns" count={`${audit.campaigns.rows.length} campaigns`} />
        <DataTable spec={{ ...audit.campaigns, total: null }} locked={locked} clearRows={2} renderCell={(c, j) => statCell(c, j, j)} />

        {/* counting */}
        <SectionHead kicker="What Google optimises toward" title="What gets counted as a win" count={`${audit.counting.rows.length} counters`} />
        <DataTable spec={{ ...audit.counting, total: null }} locked={locked} clearRows={2} renderCell={(c, j) => statCell(c, j, j)} />

        {/* tracking */}
        <SectionHead kicker="Verified by crawling your site" title="Tracking health" />
        <div className="overflow-hidden rounded border border-neutral-300 bg-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-small">
              <thead>
                <tr className="border-b border-neutral-300 bg-neutral-50">
                  {audit.tracking.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-tiny font-medium uppercase tracking-[0.1em] text-neutral-900">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audit.tracking.rows.map((row, i) => (
                  <TrackingRow key={row[0]} row={row} blur={locked && i >= 3} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* rebuild */}
        <SectionHead kicker="Built from your own 90 days of data" title="How we would rebuild Generic - Nails" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{audit.rebuild.intro}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {audit.rebuild.campaigns.map((c) => (
            <div key={c.name} className="rounded border border-neutral-300 bg-card p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-h5">{c.name}</h3>
                <span className="rounded-full bg-neutral-100 px-3 py-1 font-mono text-tiny text-neutral-900">{c.budget}</span>
              </div>
              <p className={clsx('mt-2 text-small text-neutral-900', locked && 'blurred')} aria-hidden={locked || undefined}>{c.seed}</p>
              <p className={clsx('mt-2 text-small font-medium', locked && 'blurred')} aria-hidden={locked || undefined}>{c.why}</p>
            </div>
          ))}
        </div>
        <div className={clsx('mt-3 flex items-start gap-2 rounded border border-neutral-300 bg-card p-4 text-small text-neutral-900')}>
          <Undo2 size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className={clsx(locked && 'blurred')} aria-hidden={locked || undefined}>{audit.rebuild.shared}</span>
        </div>


        {/* ---- deep sections: the money picture ---- */}
        <SectionHead kicker="Modelled from measured leaks" title="The money picture" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">
          What you spent, against what the same weeks would have cost with the measured waste removed. The shaded gap is the leak.
        </p>
        <ChartCard>
          <LineChart
            xLabels={deep.moneyPicture.xLabels}
            series={[
              { label: 'Actual spend', points: deep.moneyPicture.actual },
              { label: 'With waste removed', points: deep.moneyPicture.optimized, status: 'success' },
            ]}
            band={{ from: 1, to: 0, labels: deep.moneyPicture.saved.map((v) => `-${v}`) }}
          />
        </ChartCard>

        <SectionHead kicker="Maturity, then a reset" title="Cost per result over time" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{deep.cpaCurve.note}</p>
        <ChartCard>
          <LineChart
            xLabels={deep.cpaCurve.xLabels}
            series={[{ label: 'Cost per result', points: deep.cpaCurve.values }]}
            annotate={[{ i0: deep.cpaCurve.regressionAt - 0.5, i1: deep.cpaCurve.regressionAt, label: 'off the floor' }]}
          />
        </ChartCard>

        <SectionHead kicker="Recovered vs still bleeding" title="Where the leaks are" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{deep.leakLedger.sub}</p>
        <ChartCard>
          <StackedBarsH rows={deep.leakLedger.rows} />
        </ChartCard>

        <SectionHead kicker={`Average ${deep.qs.avg} · about $${deep.qs.premiumMonthly}/mo modelled`} title="The per-click quality tax" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{deep.qs.sub}</p>
        <ChartCard>
          <Histogram bins={deep.qs.bins} note={`average ${deep.qs.avg}`} />
        </ChartCard>

        <SectionHead kicker="Hour by hour, 30 days" title="Money hours" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{deep.hours.sub}</p>
        <ChartCard>
          <HourProfile hours={deep.hours.rows} flagged={deep.hours.flagged} />
        </ChartCard>

        <SectionHead kicker="Share of interested clicks won" title="Room to grow" />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{deep.headroom.sub}</p>
        <ChartCard>
          <ShareBars rows={deep.headroom.rows} />
        </ChartCard>
        <DataTable spec={{ columns: deep.headroom.metrics.columns, rows: deep.headroom.metrics.rows, total: null }} locked={locked} clearRows={1} renderCell={(c, j) => statCell(c, j, j)} />

        <SectionHead kicker="Counted separately on purpose" title="How people actually book" />
        <div className="overflow-hidden rounded border border-neutral-300 bg-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-small">
              <thead>
                <tr className="border-b border-neutral-300 bg-neutral-50">
                  {['Signal', 'Count', 'Share', 'Note'].map((c) => (
                    <th key={c} className="whitespace-nowrap px-4 py-2.5 text-left font-mono text-tiny font-medium uppercase tracking-[0.1em] text-neutral-900">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deep.conversionMix.map((r) => (
                  <tr key={r.signal} className="border-b border-neutral-200 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{r.signal}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.count}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.share}%</td>
                    <td className="px-4 py-2.5 text-neutral-900">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <SectionHead kicker="Serving data, last 30 days" title="What your ads say, and what Google chooses to serve" count={`${deep.copyAssets.rows.length} lines`} locked={locked} />
        <DataTable spec={{ columns: deep.copyAssets.columns, rows: deep.copyAssets.rows, total: null }} locked={locked} clearRows={3} renderCell={(c, j) => statCell(c, j, j)} />

        <SectionHead kicker="Itemised, reversible, approval-first" title="Every change, on the record" count={`${deep.register.rows.length} changes`} locked={locked} />
        <p className="mb-4 max-w-m2 text-body text-neutral-900">{deep.register.sub}</p>
        <DataTable spec={{ columns: deep.register.columns, rows: deep.register.rows, total: null }} locked={locked} clearRows={3} renderCell={(c, j) => statCell(c, j, j)} />

        <SectionHead kicker="Said plainly" title="Not yet examined" />
        <div className="flex flex-col gap-2">
          {deep.unexamined.map((u) => (
            <div key={u} className="rounded border border-neutral-300 bg-card px-4 py-3 text-small text-neutral-900">{u}</div>
          ))}
        </div>

        {/* trust footer */}
        <footer className="mt-14 border-t border-neutral-300 pt-6 pb-8">
          <p className="text-small text-neutral-900">
            Read-only today - we can look, not touch. Every fix waits for your approval, every change is reversible
            with one tap, and we watch for 48 hours after each one. Insyt - your ads and tracking, checked and fixed
            every week.
          </p>
        </footer>
      </main>

      <UnlockBar visible={locked} />
    </div>
  );
}
