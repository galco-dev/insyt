// Report charts - client twins of packages/report/src/charts.js, themed via
// the --ui-* variables so they flip with the light/dark toggle. Same rules:
// severity hues are STATUS colors only; series identity is grayscale steps
// with direct labels and distinct markers; never a dual axis (the hour view
// is two aligned panels); dashed grid at low opacity; tabular numerals.
import React from 'react';

const SERIES = ['var(--ui-strong)', 'var(--ui-n800)', 'var(--ui-n900)'];
const STATUS = {
  critical: 'var(--ui-critical)',
  warning: 'var(--ui-warning)',
  success: 'var(--ui-success)',
  info: 'var(--ui-info)',
  neutral: 'var(--ui-n800)',
};
const GRID = 'var(--ui-grid)';
const TINT_CRIT = 'color-mix(in srgb, var(--ui-critical) 9%, transparent)';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

function Marker({ shape, x, y, fill }) {
  if (shape === 'square') return <rect x={x - 3.2} y={y - 3.2} width={6.4} height={6.4} fill={fill} />;
  if (shape === 'triangle') return <path d={`M ${x} ${y - 4} L ${x + 3.8} ${y + 3.2} L ${x - 3.8} ${y + 3.2} Z`} fill={fill} />;
  return <circle cx={x} cy={y} r={3.4} fill={fill} />;
}

function Txt({ x, y, children, size = 11, fill = 'var(--ui-n900)', anchor = 'start', weight = 400 }) {
  return (
    <text x={x} y={y} fontSize={size} fill={fill} textAnchor={anchor} fontWeight={weight} fontFamily="Geist, Helvetica, sans-serif" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </text>
  );
}

function useScaleY(values, hTop, hBottom, padRatio = 0.12) {
  const max = Math.max(...values); const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1); const pad = span * padRatio;
  const lo = min === 0 ? 0 : min - pad; const hi = max + pad;
  return { y: (v) => hBottom - ((v - lo) / (hi - lo)) * (hBottom - hTop), lo, hi };
}

function Grid({ x0, x1, ys, n = 3 }) {
  const lines = [];
  let last = null;
  for (let i = 1; i <= n; i++) {
    const v = ys.lo + ((ys.hi - ys.lo) * i) / (n + 1);
    const y = ys.y(v);
    const label = fmt(v);
    lines.push(
      <g key={i}>
        <line x1={x0} x2={x1} y1={y} y2={y} stroke={GRID} strokeWidth={1} strokeDasharray="3 3" />
        {label !== last && <Txt x={x0 - 6} y={y + 3.5} anchor="end" size={10}>{label}</Txt>}
      </g>,
    );
    last = label;
  }
  return lines;
}

export function LineChart({ w = 660, h = 240, xLabels, series, band, annotate = [] }) {
  const padL = 52; const padR = 14; const padT = 26; const padB = 30;
  const x = (i) => padL + (i / (xLabels.length - 1)) * (w - padL - padR);
  const ys = useScaleY(series.flatMap((s) => s.points), padT, h - padB);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" className="block w-full" style={{ maxWidth: w }} aria-label={series.map((s) => s.label).join(' vs ')}>
      {annotate.map((a, i) => (
        <g key={i}>
          <rect x={x(a.i0)} y={padT - 8} width={x(a.i1) - x(a.i0)} height={h - padB - padT + 8} fill={TINT_CRIT} />
          {a.label && <Txt x={(x(a.i0) + x(a.i1)) / 2} y={padT + 4} anchor="middle" size={10} fill={STATUS.critical}>{a.label}</Txt>}
        </g>
      ))}
      <Grid x0={padL} x1={w - padR} ys={ys} />
      {band && (() => {
        const up = series[band.from].points; const lo = series[band.to].points;
        const fwd = up.map((v, i) => `${x(i)},${ys.y(v)}`).join(' ');
        const back = [...lo.map((v, i) => `${x(i)},${ys.y(v)}`)].reverse().join(' ');
        return (
          <g>
            <polygon points={`${fwd} ${back}`} fill={TINT_CRIT} />
            {band.labels && up.map((v, i) => (band.labels[i] != null
              ? <Txt key={i} x={x(i) + 4} y={(ys.y(v) + ys.y(lo[i])) / 2 + 3} size={10} fill={STATUS.critical} weight={600}>{band.labels[i]}</Txt>
              : null))}
          </g>
        );
      })()}
      {(() => {
        const usedLabelYs = [];
        return series.map((s, si) => {
          const color = s.status ? STATUS[s.status] : SERIES[si % SERIES.length];
          const shape = ['circle', 'square', 'triangle'][si % 3];
          const d = s.points.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${ys.y(v)}`).join(' ');
          let ly = ys.y(s.points[s.points.length - 1]) - 6;
          while (usedLabelYs.some((u) => Math.abs(u - ly) < 13)) ly += 14;
          usedLabelYs.push(ly);
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><title>{s.label}</title></path>
              {s.points.map((v, i) => <Marker key={i} shape={shape} x={x(i)} y={ys.y(v)} fill={color} />)}
              <Txt x={w - padR} y={ly} anchor="end" size={10.5} fill={color} weight={600}>{s.label}</Txt>
            </g>
          );
        });
      })()}
      {xLabels.map((l, i) => (
        <Txt key={l} x={x(i)} y={h - 10} size={10} anchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}>{l}</Txt>
      ))}
    </svg>
  );
}

// Performance, 28 days (richer-platform spec §2.5): cost and results by day
// as two aligned panels (never a dual axis), weekly checks as small ticks,
// applied fixes as marks with a short label. Grayscale series; a fix mark
// takes a severity hue only when it carries a verdict.
export function PerformanceChart({ w = 660, days, checks = [], fixes = [], labelMoney = (n) => `$${fmt(n)}` }) {
  const n = days.length;
  const padL = 52; const padR = 14; const padT = 22; const gap = 26; const padB = 24;
  const panelH = 92;
  const h = padT + panelH + gap + panelH + padB;
  const x = (i) => padL + (i / Math.max(n - 1, 1)) * (w - padL - padR);
  const idx = (iso) => { const d = String(iso || '').slice(0, 10); const i = days.findIndex((p) => p.date === d); return i; };
  const spendRaw = days.map((d) => Number(d.spend_usd || 0));
  // An outlier day (a spike several times the next highest) would flatten the
  // other 27 into a line at zero: clamp it to the chart and label it instead.
  const sortedSpend = [...spendRaw].sort((a, b) => b - a);
  const cap = sortedSpend.length > 2 && sortedSpend[0] > sortedSpend[1] * 4 ? sortedSpend[1] * 1.6 : null;
  const spend = cap ? spendRaw.map((v) => Math.min(v, cap)) : spendRaw;
  const clipped = cap ? spendRaw.map((v, i) => (v > cap ? i : -1)).filter((i) => i >= 0) : [];
  const conv = days.map((d) => Number(d.conversions || 0));
  const top = { t: padT, b: padT + panelH };
  const bot = { t: padT + panelH + gap, b: padT + panelH + gap + panelH };
  const ysT = useScaleY(spend, top.t, top.b);
  const ysB = useScaleY(conv, bot.t, bot.b);
  const checkIdx = [...new Set(checks.map(idx).filter((i) => i >= 0))];
  const fixMarks = fixes.map((f) => ({ ...f, i: idx(f.at) })).filter((f) => f.i >= 0).slice(0, 6);
  const VERDICT = { verified: STATUS.success, reverted: STATUS.warning };
  const short = (s) => (String(s || '').length > 22 ? `${String(s).slice(0, 21)}…` : String(s || ''));
  const dateLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const labelAt = [0, Math.floor((n - 1) / 2), n - 1];
  const panel = (vals, ys, color, label, fmtV) => {
    const d = vals.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${ys.y(v)}`).join(' ');
    return (
      <g>
        <Grid x0={padL} x1={w - padR} ys={ys} n={2} />
        <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><title>{label}</title></path>
        {vals.map((v, i) => <circle key={i} cx={x(i)} cy={ys.y(v)} r={1.9} fill={color} />)}
        <Txt x={padL} y={ys.y(ys.hi) + 2} size={10.5} fill={color} weight={600}>{label}</Txt>
        <Txt x={w - padR} y={ys.y(vals[n - 1]) - 6} anchor="end" size={10} fill={color}>{fmtV(vals[n - 1])}</Txt>
      </g>
    );
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" className="block w-full" style={{ maxWidth: w }} aria-label="Cost and results by day, last 28 days">
      {checkIdx.map((i) => (
        <line key={`c${i}`} x1={x(i)} x2={x(i)} y1={top.t - 6} y2={bot.b} stroke={GRID} strokeWidth={1} strokeDasharray="2 3">
          <title>Weekly check</title>
        </line>
      ))}
      {panel(spend, ysT, SERIES[0], 'Cost', labelMoney)}
      {clipped.map((i) => (
        <g key={`clip${i}`}>
          <line x1={x(i)} x2={x(i)} y1={top.t} y2={ysT.y(cap)} stroke={SERIES[0]} strokeWidth={1.8} strokeDasharray="3 3" />
          <Txt x={padL + 34} y={top.t + 12} size={10} fill={SERIES[0]} weight={600}>{`one day off the chart, ${dateLabel(days[i].date)}: ${labelMoney(spendRaw[i])}`}</Txt>
        </g>
      ))}
      {panel(conv, ysB, SERIES[1], 'Results', (v) => fmt(v))}
      {fixMarks.map((f, k) => {
        const color = VERDICT[f.state] || STATUS.neutral;
        // Shape carries the verdict as well as colour: circle verified, square put back, triangle still watching.
        const shape = f.state === 'verified' ? 'circle' : f.state === 'reverted' ? 'square' : 'triangle';
        const y = top.t - 8;
        return (
          <g key={`f${k}`}>
            <line x1={x(f.i)} x2={x(f.i)} y1={y + 4} y2={ysT.y(spend[f.i])} stroke={color} strokeWidth={1} />
            <Marker shape={shape} x={x(f.i)} y={y} fill={color} />
            {w >= 520 && k < 3 && <Txt x={Math.min(x(f.i) + 6, w - padR - 60)} y={y + 3.5} size={9.5} fill={color}>{short(f.title)}</Txt>}
            <title>{f.title}</title>
          </g>
        );
      })}
      {labelAt.map((i) => (
        <Txt key={i} x={x(i)} y={h - 6} size={10} anchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{dateLabel(days[i].date)}</Txt>
      ))}
    </svg>
  );
}

const STACK = { recovered: STATUS.success, calendar: STATUS.neutral, active: STATUS.critical };

export function StackedBarsH({ w = 660, rows, prefix = '$' }) {
  const rowH = 34; const gap = 14; const padL = 84; const padR = 14; const padT = 8;
  const h = padT + rows.length * (rowH + gap) + 26;
  const max = Math.max(...rows.map((r) => r.segments.reduce((s, g) => s + g.value, 0)));
  const legend = [...new Map(rows.flatMap((r) => r.segments.map((g) => [g.kind, g.label]))).entries()];
  let lx = padL;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" className="block w-full" style={{ maxWidth: w }}>
      {rows.map((r, ri) => {
        const y = padT + ri * (rowH + gap);
        let cx = padL;
        return (
          <g key={r.label}>
            <Txt x={padL - 8} y={y + rowH / 2 + 4} anchor="end" fill="var(--ui-strong)" weight={600} size={12}>{r.label}</Txt>
            {r.segments.filter((g) => g.value > 0).map((g) => {
              const bw = (g.value / max) * (w - padL - padR);
              const el = (
                <g key={g.kind}>
                  <rect x={cx} y={y} width={Math.max(bw - 2, 1)} height={rowH} rx={4} fill={STACK[g.kind]}>
                    <title>{`${r.label} · ${g.label}: ${prefix}${fmt(g.value)}`}</title>
                  </rect>
                  {bw > 48 && <Txt x={cx + (bw - 2) / 2} y={y + rowH / 2 + 4} anchor="middle" fill="var(--ui-page)" weight={600}>{fmt(g.value)}</Txt>}
                </g>
              );
              cx += bw;
              return el;
            })}
          </g>
        );
      })}
      {legend.map(([kind, label]) => {
        const el = (
          <g key={kind}>
            <rect x={lx} y={h - 17} width={10} height={10} rx={2} fill={STACK[kind]} />
            <Txt x={lx + 14} y={h - 8} size={10.5}>{label}</Txt>
          </g>
        );
        lx += 14 + label.length * 5.6 + 22;
        return el;
      })}
    </svg>
  );
}

export function Histogram({ w = 660, h = 210, bins, note }) {
  const padL = 34; const padR = 14; const padT = 16; const padB = 28;
  const max = Math.max(...bins.map((b) => b.count));
  const bw = (w - padL - padR) / bins.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" className="block w-full" style={{ maxWidth: w }}>
      {bins.map((b, i) => {
        const bh = (b.count / max) * (h - padT - padB);
        const x0 = padL + i * bw + 3; const y0 = h - padB - bh;
        return (
          <g key={b.label}>
            <rect x={x0} y={y0} width={bw - 6} height={bh} rx={4} fill={STATUS[b.status]}><title>{`${b.label}: ${b.count}`}</title></rect>
            <Txt x={x0 + (bw - 6) / 2} y={y0 - 5} anchor="middle" size={10.5} fill="var(--ui-strong)" weight={600}>{b.count}</Txt>
            <Txt x={x0 + (bw - 6) / 2} y={h - 10} anchor="middle" size={10}>{b.label}</Txt>
          </g>
        );
      })}
      {note && <Txt x={w - padR} y={padT} anchor="end" size={10.5}>{note}</Txt>}
    </svg>
  );
}

export function HourProfile({ w = 660, hours, flagged = [], prefix = '$' }) {
  const padL = 52; const padR = 14; const p1T = 18; const p1B = 118; const p2T = 142; const p2B = 236; const h = 262;
  const bw = (w - padL - padR) / 24;
  const maxSpend = Math.max(...hours.map((r) => r.spend));
  const pts = hours.filter((r) => r.cpa != null);
  const ys = useScaleY(pts.map((r) => r.cpa), p2T, p2B);
  const x = (hour) => padL + hour * bw + bw / 2;
  const d = pts.map((r, i) => `${i ? 'L' : 'M'} ${x(r.hour)} ${ys.y(r.cpa)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" className="block w-full" style={{ maxWidth: w }}>
      <Txt x={padL} y={12} size={10.5} weight={600} fill="var(--ui-strong)">Spend by hour</Txt>
      {hours.map((r) => {
        const bh = (r.spend / maxSpend) * (p1B - p1T);
        const bad = flagged.includes(r.hour);
        return (
          <rect key={r.hour} x={padL + r.hour * bw + 1.5} y={p1B - bh} width={bw - 3} height={bh} rx={3}
            fill={bad ? TINT_CRIT : 'var(--ui-n300)'} stroke={bad ? STATUS.critical : 'none'} strokeWidth={bad ? 1 : 0}>
            <title>{`${String(r.hour).padStart(2, '0')}:00 · spend ${prefix}${fmt(r.spend)}`}</title>
          </rect>
        );
      })}
      <Txt x={padL} y={p2T - 8} size={10.5} weight={600} fill="var(--ui-strong)">Cost per result by hour</Txt>
      <Grid x0={padL} x1={w - padR} ys={ys} n={2} />
      <path d={d} fill="none" stroke="var(--ui-strong)" strokeWidth={2} strokeLinejoin="round" />
      {pts.map((r) => {
        const bad = flagged.includes(r.hour);
        return (
          <g key={r.hour}>
            <Marker shape="circle" x={x(r.hour)} y={ys.y(r.cpa)} fill={bad ? STATUS.critical : 'var(--ui-strong)'} />
            {bad && <Txt x={x(r.hour)} y={ys.y(r.cpa) - 8} anchor="middle" size={10} fill={STATUS.critical} weight={600}>{`${String(r.hour).padStart(2, '0')}:00 · ${prefix}${fmt(r.cpa)}`}</Txt>}
          </g>
        );
      })}
      {[0, 4, 8, 12, 16, 20].map((hh) => (
        <Txt key={hh} x={x(hh)} y={h - 8} anchor="middle" size={10}>{String(hh).padStart(2, '0')}</Txt>
      ))}
    </svg>
  );
}

export function ShareBars({ w = 660, rows }) {
  const rowH = 26; const gap = 14; const padL = 84; const padR = 64; const padT = 6;
  const h = padT + rows.length * (rowH + gap) + 8;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" className="block w-full" style={{ maxWidth: w }}>
      {rows.map((r, i) => {
        const y = padT + i * (rowH + gap);
        const trackW = w - padL - padR;
        return (
          <g key={r.label}>
            <Txt x={padL - 8} y={y + rowH / 2 + 4} anchor="end" fill="var(--ui-strong)" weight={600} size={12}>{r.label}</Txt>
            <rect x={padL} y={y} width={trackW} height={rowH} rx={4} fill="var(--ui-n100)" />
            <rect x={padL} y={y} width={Math.max((r.pct / 100) * trackW, 2)} height={rowH} rx={4} fill="var(--ui-strong)">
              <title>{`${r.label}: ${r.pct}% of interested clicks won`}</title>
            </rect>
            <Txt x={padL + (r.pct / 100) * trackW + 8} y={y + rowH / 2 + 4} size={11} fill="var(--ui-strong)" weight={600}>{`${r.pct}%`}</Txt>
          </g>
        );
      })}
    </svg>
  );
}
