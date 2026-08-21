// Shared atoms - one visual language for every screen.
// Premium dark spec (v28): every icon sits in a double bezel, light always
// from above, never flat 1px borders, severity colors are the only hues.
// Brand ramp is SILVER monochrome (decided 21 Aug 2026) so it continues the
// monochrome Webflow landing pages; "interactive" is signalled by luminance,
// not hue - the primary button is a light plate with dark ink.
import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertOctagon, AlertTriangle, InfoCircle, CheckCircle, ArrowRight } from '@untitledui/icons';

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

export const SEV_ICON = { critical: AlertOctagon, warning: AlertTriangle, info: InfoCircle, success: CheckCircle };

export const COLOR = {
  critical: { text: 'text-critical', bg: 'bg-critical', tint: 'bg-critical-tint', borderL: 'border-l-critical' },
  warning: { text: 'text-warning', bg: 'bg-warning', tint: 'bg-warning-tint', borderL: 'border-l-warning' },
  info: { text: 'text-info', bg: 'bg-info', tint: 'bg-info-tint', borderL: 'border-l-info' },
  success: { text: 'text-success', bg: 'bg-success', tint: 'bg-success-tint', borderL: 'border-l-success' },
};

// Raw severity hexes for SVG work (sparkline strokes, ring gradients).
export const SEV_HEX = { critical: '#f05252', warning: '#f5a524', success: '#2fbf71', info: '#4d9fec' };

/* ---------------------------------------------------------------- IconBezel
   The double-plate law: every icon sits in two nested rounded squares, each
   with its own gradient, ring and shadow. Light always from above. Active
   variant lifts the inner plate to bright silver with dark ink. */
const BEZEL_SIZE = {
  sm: { outer: 'h-[34px] w-[34px] rounded-[9px]', inner: 'h-[25px] w-[25px] rounded-[6px]', icon: 13 },
  md: { outer: 'h-11 w-11 rounded-[11px]', inner: 'h-[33px] w-[33px] rounded-[8px]', icon: 16 },
  lg: { outer: 'h-14 w-14 rounded-[13px]', inner: 'h-[42px] w-[42px] rounded-[10px]', icon: 20 },
};

export function IconBezel({ icon: Icon, size = 'md', active = false, tone, className, iconClassName }) {
  const s = BEZEL_SIZE[size] || BEZEL_SIZE.md;
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-grid shrink-0 place-items-center bg-gradient-to-b from-[#26282a] to-[#0e100f]',
        'ring-1 ring-inset ring-white/[0.16] shadow-[0_2px_6px_rgba(0,0,0,0.5)]',
        s.outer,
        className,
      )}
    >
      <span
        className={clsx(
          'grid place-items-center ring-1 ring-inset',
          s.inner,
          active
            ? 'bg-gradient-to-b from-brand-400 to-brand-600 text-page ring-brand-300/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_4px_rgba(0,0,0,0.6)]'
            : 'bg-gradient-to-b from-[#161817] to-[#080909] ring-white/[0.09] shadow-[0_1px_3px_rgba(0,0,0,0.6)]',
          !active && (tone ? COLOR[tone].text : 'text-neutral-900'),
        )}
      >
        {Icon && <Icon size={s.icon} strokeWidth={2} className={iconClassName} />}
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------- BrandOrb
   The brand mark: a chrome sphere across the silver ramp, light tint
   top-left to near-black bottom-right, tiny warm glint. */
export function BrandOrb({ size = 28, className }) {
  return (
    <span
      aria-hidden
      className={clsx('relative inline-block shrink-0 rounded-full', className)}
      style={{
        width: size,
        height: size,
        background:
          'radial-gradient(circle at 32% 26%, #f4f5f6, #b9bdc3 45%, #5f646c 74%, #060607 98%)',
        boxShadow: '0 3px 9px rgba(0,0,0,0.55), inset 0 1px 1px rgba(255,255,255,0.3)',
      }}
    >
      <span
        className="absolute rounded-full"
        style={{
          top: size * 0.13,
          left: size * 0.22,
          width: size * 0.16,
          height: size * 0.11,
          background: 'rgba(255,248,238,0.85)',
          filter: 'blur(1.2px)',
          transform: 'rotate(-20deg)',
        }}
      />
    </span>
  );
}

/* ---------------------------------------------------------------- Spinner
   Never a plain spinner: the brand orb with a thin orbiting arc. */
export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-neutral-900" role="status">
      <span className="relative inline-grid h-12 w-12 place-items-center" aria-hidden>
        <BrandOrb size={26} />
        <svg viewBox="0 0 48 48" className="orbit absolute inset-0 h-full w-full">
          <circle
            cx="24" cy="24" r="21.5" fill="none" stroke="#d9dbde" strokeWidth="1.5"
            strokeLinecap="round" strokeDasharray="34 101" opacity="0.9"
          />
        </svg>
      </span>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em]">{label}</div>
    </div>
  );
}
export const OrbLoader = Spinner;

/* ------------------------------------------------------------- ProgressRing
   Any percentage becomes a ring: two-stop silver gradient stroke, rounded
   caps, dashoffset animates on mount (skipped for reduced motion). */
let ringSeq = 0;
export function ProgressRing({ value = 0, size = 56, stroke = 5, stops, className, children }) {
  const [drawn, setDrawn] = useState(false);
  const idRef = useRef(null);
  if (idRef.current === null) { ringSeq += 1; idRef.current = `ring-g-${ringSeq}`; }
  const reduced = typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (reduced) { setDrawn(true); return undefined; }
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = c * (1 - (drawn ? clamped : 0) / 100);
  return (
    <span className={clsx('relative inline-grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={idRef.current} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={(stops && stops[0]) || '#f4f5f6'} />
            <stop offset="1" stopColor={(stops && stops[1]) || '#8f949c'} stopOpacity={stops ? 0.6 : 1} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={`url(#${idRef.current})`} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset}
          style={{ transition: reduced ? 'none' : 'stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1)' }}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-small font-semibold tabular-nums">
        {children ?? Math.round(clamped)}
      </span>
    </span>
  );
}

/* --------------------------------------------------------------------- Pill
   Status pill: a dot with a halo ring of the same hue at low opacity. */
const PILL_DOT = {
  critical: { bg: 'bg-critical', halo: 'rgba(240,82,82,0.22)' },
  warning: { bg: 'bg-warning', halo: 'rgba(245,165,36,0.22)' },
  success: { bg: 'bg-success', halo: 'rgba(47,191,113,0.22)' },
  info: { bg: 'bg-info', halo: 'rgba(77,159,236,0.22)' },
  brand: { bg: 'bg-brand-300', halo: 'rgba(244,245,246,0.2)' },
  neutral: { bg: 'bg-neutral-800', halo: 'rgba(255,255,255,0.1)' },
};

export function Pill({ tone = 'neutral', children, className }) {
  const d = PILL_DOT[tone] || PILL_DOT.neutral;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 text-small text-strong',
        'ring-1 ring-inset ring-white/[0.07]',
        className,
      )}
    >
      <span aria-hidden className={clsx('h-[7px] w-[7px] shrink-0 rounded-full', d.bg)} style={{ boxShadow: `0 0 0 3px ${d.halo}` }} />
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- Skeleton */
export function Skeleton({ className }) {
  return <div aria-hidden className={clsx('shimmer rounded', className)} />;
}

/* ---------------------------------------------------------------- MonoLabel */
export function MonoLabel({ children, className }) {
  return (
    <div className={clsx('font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-800', className)}>
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

/* ------------------------------------------------------------------- Button
   Monochrome ramp: hue cannot say "interactive", luminance does. Primary is
   a light machined plate with dark ink (the inverse of the page); secondary
   is a dark plate with a skeuomorphic top highlight. 150ms transitions. */
export function Button({ children, onClick, href, variant = 'primary', className, disabled }) {
  const cls = clsx(
    'inline-flex items-center justify-center gap-2 rounded px-6 py-3 text-small font-medium',
    'transition-[filter,background-color,opacity] duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-300',
    variant === 'primary'
      && 'bg-gradient-to-b from-brand-300 to-brand-400 text-page ring-1 ring-inset ring-brand-500/50 shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.55)] hover:brightness-[1.05]',
    variant === 'secondary'
      && 'bg-gradient-to-b from-white/[0.08] to-white/[0.03] text-strong ring-1 ring-inset ring-white/[0.12] shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)] hover:from-white/[0.11] hover:to-white/[0.05]',
    variant === 'ghost' && 'px-2 text-strong underline underline-offset-4 hover:text-neutral-900',
    disabled && 'pointer-events-none opacity-40',
    className,
  );
  if (href) return <a href={href} className={cls}>{children}</a>;
  return <button type="button" onClick={onClick} disabled={disabled} className={cls}>{children}</button>;
}

/* --------------------------------------------------------------------- Card
   Never flat 1px borders: an inset ring over a subtle vertical gradient. */
export function Card({ children, className, accent, style }) {
  return (
    <div
      style={style}
      className={clsx(
        'rounded-lg bg-gradient-to-b from-card-hi to-card ring-1 ring-inset ring-white/[0.07]',
        'shadow-[0_12px_32px_-20px_rgba(0,0,0,0.8)]',
        accent && `border-l-[3px] ${COLOR[accent].borderL}`,
        className,
      )}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- EmptyState
   IconBezel with concentric halo rings fading outward. */
export function EmptyState({ title, body, cta, icon = InfoCircle }) {
  return (
    <div className="relative overflow-hidden rounded-lg bg-gradient-to-b from-card-hi to-card px-6 py-14 text-center ring-1 ring-inset ring-white/[0.07]">
      <div className="relative mx-auto mb-5 grid h-14 w-14 place-items-center">
        <span aria-hidden className="absolute h-[88px] w-[88px] rounded-full ring-1 ring-white/[0.06]" />
        <span aria-hidden className="absolute h-[128px] w-[128px] rounded-full ring-1 ring-white/[0.04]" />
        <span aria-hidden className="absolute h-[168px] w-[168px] rounded-full ring-1 ring-white/[0.02]" />
        <IconBezel icon={icon} size="lg" />
      </div>
      <h3 className="text-h5">{title}</h3>
      {body && <p className="mx-auto mt-2 max-w-s2 text-small text-neutral-900">{body}</p>}
      {cta && <div className="mt-5 flex justify-center">{cta}</div>}
    </div>
  );
}

export function ErrorNote({ message }) {
  return (
    <div className="flex items-start gap-2 rounded bg-warning-tint p-4 text-small text-strong ring-1 ring-inset ring-warning/25">
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
    <div className="mt-6 flex flex-col items-start gap-3 rounded-lg bg-gradient-to-b from-card-hi to-card p-5 ring-1 ring-inset ring-white/[0.07] sm:flex-row sm:items-center sm:justify-between">
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

/* ---------------------------------------------------------------- Sparkline
   Score trends: gradient area fill fading to transparent, dashed grid at
   very low opacity, endpoint emphasized with a halo dot. Color follows the
   latest point's health band. */
let sparkSeq = 0;
export function Sparkline({ points, width = 96, height = 28 }) {
  const idRef = useRef(null);
  if (idRef.current === null) { sparkSeq += 1; idRef.current = `spark-g-${sparkSeq}`; }
  if (!points || points.length < 2) return null;
  const scores = points.map((p) => (typeof p === 'number' ? p : p.score));
  const min = Math.min(...scores); const max = Math.max(...scores);
  const span = Math.max(max - min, 1); const pad = 3;
  const xy = scores.map((s, i) => [
    pad + (i / (scores.length - 1)) * (width - pad * 2),
    height - pad - ((s - min) / span) * (height - pad * 2),
  ]);
  const last = scores[scores.length - 1];
  const stroke = last < 50 ? SEV_HEX.critical : last < 70 ? SEV_HEX.warning : SEV_HEX.success;
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${d} L ${xy[xy.length - 1][0].toFixed(1)} ${height - 1} L ${xy[0][0].toFixed(1)} ${height - 1} Z`;
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <defs>
        <linearGradient id={idRef.current} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f} x1={pad} x2={width - pad} y1={height * f} y2={height * f}
          stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="3 3"
        />
      ))}
      <path d={area} fill={`url(#${idRef.current})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="2.5" fill={stroke} />
      <circle cx={lx} cy={ly} r="2.5" fill="none" stroke={stroke} strokeOpacity="0.25" strokeWidth="3" />
    </svg>
  );
}

export { ArrowRight };
