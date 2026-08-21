// Shared atoms - one visual language for every screen.
// Premium spec (v28): every icon sits in a double bezel, light always from
// above, never flat 1px borders, severity colors are the only hues. Two
// themes, one geometry: DARK (default, near-black + silver mono ramp) and
// LIGHT (mono twin of the Webflow landing pages). All theme-dependent color
// lives in the --ui-* variables (src/index.css); "interactive" is signalled
// by luminance, not hue - the primary button is the inverse plate of the
// page in both themes, so text-page is always its ink.
import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertOctagon, AlertTriangle, InfoCircle, CheckCircle, ArrowRight, Moon01, Sun } from '@untitledui/icons';

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

// Severity colors for SVG/inline-style work. CSS variables so they follow
// the active theme; apply via `style`, not SVG presentation attributes.
export const SEV_HEX = {
  critical: 'var(--ui-critical)',
  warning: 'var(--ui-warning)',
  success: 'var(--ui-success)',
  info: 'var(--ui-info)',
};

/* ---------------------------------------------------------------- theme
   Dark is the default (the html tag ships with class="dark-mode"; an inline
   head script honors a stored 'light' choice before first paint). */
const THEME_KEY = 'insyt-theme';

export function useTheme() {
  const [mode, setMode] = useState(() => (
    typeof document !== 'undefined' && !document.documentElement.classList.contains('dark-mode')
      ? 'light' : 'dark'
  ));
  const toggle = () => {
    setMode((m) => {
      const next = m === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark-mode', next === 'dark');
      try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
      return next;
    });
  };
  return [mode, toggle];
}

export function ThemeToggle({ className }) {
  const [mode, toggle] = useTheme();
  const IconEl = mode === 'dark' ? Sun : Moon01;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={mode === 'dark' ? 'Light mode' : 'Dark mode'}
      className={clsx(
        'grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-neutral-900',
        'bg-gradient-to-b from-(--ui-plate-a) to-(--ui-plate-b) ring-1 ring-inset ring-(--ui-ring-strong)',
        'shadow-[inset_0_1px_0_var(--ui-plate-hi)] transition-[filter] duration-150 hover:brightness-110',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-focus)',
        className,
      )}
    >
      <IconEl size={15} strokeWidth={2} aria-hidden />
    </button>
  );
}

/* ---------------------------------------------------------------- IconBezel
   The double-plate law: every icon sits in two nested rounded squares, each
   with its own gradient, ring and shadow. Light always from above. Active
   variant lifts the inner plate to the theme's inverse (page-ink plate). */
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
        'inline-grid shrink-0 place-items-center bg-gradient-to-b from-(--ui-bezel-outer-a) to-(--ui-bezel-outer-b)',
        'ring-1 ring-inset ring-(--ui-bezel-outer-ring) shadow-[0_2px_6px_rgba(0,0,0,0.35)]',
        s.outer,
        className,
      )}
    >
      <span
        className={clsx(
          'grid place-items-center ring-1 ring-inset',
          s.inner,
          active
            ? 'bg-gradient-to-b from-(--ui-bezel-active-a) to-(--ui-bezel-active-b) text-page ring-(--ui-bezel-active-ring) shadow-[inset_0_1px_0_var(--ui-cta-hi),0_1px_4px_rgba(0,0,0,0.4)]'
            : 'bg-gradient-to-b from-(--ui-bezel-inner-a) to-(--ui-bezel-inner-b) ring-(--ui-bezel-inner-ring) shadow-[0_1px_3px_rgba(0,0,0,0.35)]',
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
   top-left to near-black bottom-right, tiny warm glint. Constant across
   themes - it is the logo, not chrome. */
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
        boxShadow: '0 3px 9px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.3)',
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

/* ------------------------------------------------------------------ Spinner
   Never a plain spinner: the brand orb with a thin orbiting arc. */
export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-neutral-900" role="status">
      <span className="relative inline-grid h-12 w-12 place-items-center" aria-hidden>
        <BrandOrb size={26} />
        <svg viewBox="0 0 48 48" className="orbit absolute inset-0 h-full w-full">
          <circle
            cx="24" cy="24" r="21.5" fill="none" strokeWidth="1.5"
            strokeLinecap="round" strokeDasharray="34 101"
            style={{ stroke: 'var(--ui-arc)', opacity: 0.9 }}
          />
        </svg>
      </span>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em]">{label}</div>
    </div>
  );
}
export const OrbLoader = Spinner;

/* ------------------------------------------------------------- ProgressRing
   Any percentage becomes a ring: two-stop gradient stroke (theme silver by
   default, severity hue via `stops`), rounded caps, dashoffset animates on
   mount (skipped for reduced motion). */
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
            <stop offset="0" style={{ stopColor: (stops && stops[0]) || 'var(--ui-ring-stop-a)' }} />
            <stop offset="1" style={{ stopColor: (stops && stops[1]) || 'var(--ui-ring-stop-b)', stopOpacity: stops ? 0.6 : 1 }} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: 'var(--ui-ring)' }} />
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
  critical: { bg: 'bg-critical', halo: 'color-mix(in srgb, var(--ui-critical) 22%, transparent)' },
  warning: { bg: 'bg-warning', halo: 'color-mix(in srgb, var(--ui-warning) 22%, transparent)' },
  success: { bg: 'bg-success', halo: 'color-mix(in srgb, var(--ui-success) 22%, transparent)' },
  info: { bg: 'bg-info', halo: 'color-mix(in srgb, var(--ui-info) 22%, transparent)' },
  brand: { bg: 'bg-(--ui-cta-a)', halo: 'var(--ui-dot-halo)' },
  neutral: { bg: 'bg-neutral-800', halo: 'var(--ui-ring-strong)' },
};

export function Pill({ tone = 'neutral', children, className }) {
  const d = PILL_DOT[tone] || PILL_DOT.neutral;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full bg-(--ui-well) px-3 py-1.5 text-small text-strong',
        'ring-1 ring-inset ring-(--ui-ring)',
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
   Mono ramp: hue cannot say "interactive", luminance does. Primary is the
   page's inverse plate (light plate on dark, dark plate on light), so
   text-page is its ink in both themes. 150ms transitions. */
export function Button({ children, onClick, href, variant = 'primary', className, disabled }) {
  const cls = clsx(
    'inline-flex items-center justify-center gap-2 rounded px-6 py-3 text-small font-medium',
    'transition-[filter,background-color,opacity] duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-focus)',
    variant === 'primary'
      && 'bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) text-page ring-1 ring-inset ring-(--ui-cta-edge) shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_var(--ui-cta-hi)] hover:brightness-[1.05]',
    variant === 'secondary'
      && 'bg-gradient-to-b from-(--ui-plate-a) to-(--ui-plate-b) text-strong ring-1 ring-inset ring-(--ui-ring-strong) shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_1px_0_var(--ui-plate-hi)] hover:from-(--ui-plate-a-h) hover:to-(--ui-plate-b-h)',
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
        'rounded-lg bg-gradient-to-b from-card-hi to-card ring-1 ring-inset ring-(--ui-ring)',
        'shadow-[0_12px_32px_-20px_rgba(0,0,0,0.35)]',
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
    <div className="relative overflow-hidden rounded-lg bg-gradient-to-b from-card-hi to-card px-6 py-14 text-center ring-1 ring-inset ring-(--ui-ring)">
      <div className="relative mx-auto mb-5 grid h-14 w-14 place-items-center">
        <span aria-hidden className="absolute h-[88px] w-[88px] rounded-full ring-1 ring-(--ui-echo-a)" />
        <span aria-hidden className="absolute h-[128px] w-[128px] rounded-full ring-1 ring-(--ui-echo-b)" />
        <span aria-hidden className="absolute h-[168px] w-[168px] rounded-full ring-1 ring-(--ui-echo-c)" />
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
    <div className="mt-6 flex flex-col items-start gap-3 rounded-lg bg-gradient-to-b from-card-hi to-card p-5 ring-1 ring-inset ring-(--ui-ring) sm:flex-row sm:items-center sm:justify-between">
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
   latest point's health band; all colors are theme variables via style. */
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
          <stop offset="0" style={{ stopColor: stroke, stopOpacity: 0.22 }} />
          <stop offset="1" style={{ stopColor: stroke, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f} x1={pad} x2={width - pad} y1={height * f} y2={height * f}
          strokeWidth="1" strokeDasharray="3 3" style={{ stroke: 'var(--ui-grid)' }}
        />
      ))}
      <path d={area} fill={`url(#${idRef.current})`} />
      <path d={d} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke }} />
      <circle cx={lx} cy={ly} r="2.5" style={{ fill: stroke }} />
      <circle cx={lx} cy={ly} r="2.5" fill="none" strokeWidth="3" style={{ stroke, strokeOpacity: 0.25 }} />
    </svg>
  );
}

export { ArrowRight };
