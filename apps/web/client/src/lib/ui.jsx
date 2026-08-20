// Shared atoms — one visual language for every screen (§18.1 tokens only).
import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertOctagon, AlertTriangle, Info, CheckCircle2, ArrowRight } from 'lucide-react';

export const severityMeta = {
  critical: { label: 'Critical', color: 'critical' },
  warning: { label: 'Worth fixing', color: 'warning' },
  info: { label: 'Good to know', color: 'info' },
};

export const verdictMeta = {
  keep: { label: 'Keep', color: 'success' },
  promote: { label: 'Promote', color: 'info' },
  negative: { label: 'Exclude', color: 'critical' },
  rebid: { label: 'Rebid', color: 'warning' },
  pause: { label: 'Pause', color: 'warning' },
  demote: { label: 'Demote', color: 'warning' },
  retire: { label: 'Retire', color: 'critical' },
  restructure: { label: 'Rebuild', color: 'warning' },
};

export const SEV_ICON = { critical: AlertOctagon, warning: AlertTriangle, info: Info, success: CheckCircle2 };

export const COLOR = {
  critical: { text: 'text-critical', bg: 'bg-critical', tint: 'bg-critical-tint', borderL: 'border-l-critical' },
  warning: { text: 'text-warning', bg: 'bg-warning', tint: 'bg-warning-tint', borderL: 'border-l-warning' },
  info: { text: 'text-info', bg: 'bg-info', tint: 'bg-info-tint', borderL: 'border-l-info' },
  success: { text: 'text-success', bg: 'bg-success', tint: 'bg-success-tint', borderL: 'border-l-success' },
};

export function MonoLabel({ children, className }) {
  return (
    <div className={clsx('font-mono text-tiny uppercase tracking-[0.12em] text-neutral-900', className)}>
      {children}
    </div>
  );
}

export function SeverityBadge({ severity }) {
  const m = severityMeta[severity];
  const IconEl = SEV_ICON[severity];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 font-mono text-tiny uppercase tracking-[0.1em]', COLOR[m.color].text)}>
      <IconEl size={13} strokeWidth={2.4} aria-hidden />
      {m.label}
    </span>
  );
}

export function Button({ children, onClick, href, variant = 'primary', className, disabled }) {
  const cls = clsx(
    'inline-flex items-center justify-center gap-2 rounded px-6 py-3 text-small font-medium transition-opacity',
    variant === 'primary' && 'bg-accent text-white hover:opacity-90',
    variant === 'secondary' && 'border border-neutral-500 bg-white text-accent hover:bg-neutral-50',
    variant === 'ghost' && 'text-accent underline underline-offset-4 px-2',
    disabled && 'opacity-40 pointer-events-none',
    className,
  );
  if (href) return <a href={href} className={cls}>{children}</a>;
  return <button type="button" onClick={onClick} disabled={disabled} className={cls}>{children}</button>;
}

export function Card({ children, className, accent, style }) {
  return (
    <div style={style} className={clsx('rounded border border-neutral-300 bg-white', accent && `border-l-[3px] ${COLOR[accent].borderL}`, className)}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-neutral-900" role="status">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-400 border-t-accent" aria-hidden />
      <div className="font-mono text-tiny uppercase tracking-[0.12em]">{label}</div>
    </div>
  );
}

export function EmptyState({ title, body, cta }) {
  return (
    <div className="rounded border border-dashed border-neutral-500 bg-white px-6 py-14 text-center">
      <h3 className="text-h5">{title}</h3>
      {body && <p className="mx-auto mt-2 max-w-s2 text-small text-neutral-900">{body}</p>}
      {cta && <div className="mt-5 flex justify-center">{cta}</div>}
    </div>
  );
}

export function ErrorNote({ message }) {
  return (
    <div className="flex items-start gap-2 rounded border border-neutral-300 bg-warning-tint p-4 text-small">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

export function SectionHead({ kicker, title, right }) {
  return (
    <div className="mt-10 mb-4 flex items-end justify-between gap-4">
      <div>
        {kicker && <MonoLabel>{kicker}</MonoLabel>}
        <h2 className="mt-1 text-h4">{title}</h2>
      </div>
      {right}
    </div>
  );
}

export function CtaRow({ label, sub, action }) {
  return (
    <div className="mt-6 flex flex-col items-start gap-3 rounded border border-neutral-300 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-body font-semibold">{label}</div>
        {sub && <div className="mt-0.5 text-small text-neutral-900">{sub}</div>}
      </div>
      {action}
    </div>
  );
}

// Count a number up from 0 on mount (~700ms, ease-out). Renders the final
// value immediately for prefers-reduced-motion users and non-browser renders.
export function useCountUp(target, duration = 700) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [value, setValue] = useState(reduced ? target : 0);
  useEffect(() => {
    if (reduced || !Number.isFinite(target)) { setValue(target); return undefined; }
    let raf; const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / duration);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);
  return value;
}

// Tiny sparkline for score trends. Color follows the latest point's health band.
export function Sparkline({ points, width = 96, height = 28 }) {
  if (!points || points.length < 2) return null;
  const scores = points.map((p) => (typeof p === 'number' ? p : p.score));
  const min = Math.min(...scores); const max = Math.max(...scores);
  const span = Math.max(max - min, 1); const pad = 2;
  const xy = scores.map((s, i) => [
    pad + (i / (scores.length - 1)) * (width - pad * 2),
    height - pad - ((s - min) / span) * (height - pad * 2),
  ]);
  const last = scores[scores.length - 1];
  const stroke = last < 50 ? '#DC2626' : last < 70 ? '#D97706' : '#16A34A';
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="2.5" fill={stroke} />
    </svg>
  );
}

export { ArrowRight };
