// Deep-report chart layer — pure SVG string generators, zero dependencies.
// One renderer discipline: these serve the WEB report HTML (email mode gets
// stat-row fallbacks; SVG dies in Gmail). Light mono palette + severity hues
// as STATUS colors only; series identity is grayscale steps with mandatory
// direct labels and distinct markers (validated 21 Aug 2026, dataviz method:
// green|neutral|red stack adjacency passes CVD + normal-vision checks; the
// grayscale series pair relief is direct labels + the adjacent data tables).
// Never a dual axis: the hour profile is two aligned panels.

const C = {
  ink: '#16181b',
  gray: '#6d727a',
  graylt: '#8f949c',
  muted: '#6d727a',
  grid: 'rgba(0,0,0,0.07)',
  axis: 'rgba(0,0,0,0.18)',
  card: '#ffffff',
  critical: '#DC2626',
  warning: '#D97706',
  success: '#16A34A',
  info: '#2563EB',
  criticalTint: 'rgba(220,38,38,0.08)',
  font: "'Geist', Helvetica, Arial, sans-serif",
};

const SERIES = [C.ink, C.gray, C.graylt]; // fixed order, never cycled
const MARKERS = ['circle', 'square', 'triangle'];

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function marker(shape, x, y, color) {
  if (shape === 'square') return `<rect x="${x - 3.2}" y="${y - 3.2}" width="6.4" height="6.4" fill="${color}"><title></title></rect>`;
  if (shape === 'triangle') return `<path d="M ${x} ${y - 4} L ${x + 3.8} ${y + 3.2} L ${x - 3.8} ${y + 3.2} Z" fill="${color}"/>`;
  return `<circle cx="${x}" cy="${y}" r="3.4" fill="${color}"/>`;
}

function text(x, y, s, { size = 11, color = C.muted, anchor = 'start', weight = 400 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${C.font}" font-size="${size}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}" style="font-variant-numeric:tabular-nums">${esc(s)}</text>`;
}

function frame(w, h, inner) {
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" style="max-width:${w}px;display:block">${inner}</svg>`;
}

function scaleY(values, hTop, hBottom, padRatio = 0.12) {
  const max = Math.max(...values); const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1); const pad = span * padRatio;
  const lo = min === 0 ? 0 : min - pad; const hi = max + pad;
  return { y: (v) => hBottom - ((v - lo) / (hi - lo)) * (hBottom - hTop), lo, hi };
}

function gridLines(x0, x1, hTop, hBottom, yScale, n = 3) {
  let out = '';
  for (let i = 1; i <= n; i++) {
    const v = yScale.lo + ((yScale.hi - yScale.lo) * i) / (n + 1);
    const y = yScale.y(v);
    out += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1" stroke-dasharray="3 3"/>`;
    out += text(x0 - 6, y + 3.5, fmt(v), { anchor: 'end', size: 10 });
  }
  return out;
}

/**
 * Multi-series line chart. series: [{ label, points: [num], status? }] where
 * status ('success'|'critical'|...) borrows a reserved hue; otherwise fixed
 * grayscale order. band: {from, to} shades between two series (waste band).
 * xLabels shared. annotate: [{ i0, i1, label }] shades an x-range.
 */
function lineChart({ w = 660, h = 240, xLabels, series, band, annotate = [], yFmt = fmt }) {
  const padL = 52; const padR = 14; const padT = 26; const padB = 30;
  const x = (i) => padL + (i / (xLabels.length - 1)) * (w - padL - padR);
  const all = series.flatMap((s) => s.points);
  const ys = scaleY(all, padT, h - padB);
  let out = '';
  for (const a of annotate) {
    out += `<rect x="${x(a.i0)}" y="${padT - 8}" width="${x(a.i1) - x(a.i0)}" height="${h - padB - padT + 8}" fill="${C.criticalTint}"/>`;
    if (a.label) out += text((x(a.i0) + x(a.i1)) / 2, padT + 4, a.label, { anchor: 'middle', size: 10, color: C.critical });
  }
  out += gridLines(padL, w - padR, padT, h - padB, ys);
  if (band) {
    const up = series[band.from].points; const lo = series[band.to].points;
    const fwd = up.map((v, i) => `${x(i)},${ys.y(v)}`).join(' ');
    const back = [...lo.map((v, i) => `${x(i)},${ys.y(v)}`)].reverse().join(' ');
    out += `<polygon points="${fwd} ${back}" fill="${C.criticalTint}"/>`;
    if (band.labels) {
      up.forEach((v, i) => {
        const d = lo[i] - v === 0 ? null : band.labels[i];
        if (d != null) out += text(x(i) + 4, (ys.y(v) + ys.y(lo[i])) / 2 + 3, d, { size: 10, color: C.critical, weight: 600 });
      });
    }
  }
  const usedLabelYs = [];
  series.forEach((s, si) => {
    const color = s.status ? C[s.status] : SERIES[si % SERIES.length];
    const shape = MARKERS[si % MARKERS.length];
    const d = s.points.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${ys.y(v)}`).join(' ');
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>${esc(s.label)}</title></path>`;
    s.points.forEach((v, i) => { out += marker(shape, x(i), ys.y(v), color); });
    // direct label at line end (mandatory for grayscale identity); staggered
    // when series converge so labels never collide.
    let ly = ys.y(s.points[s.points.length - 1]) - 6;
    while (usedLabelYs.some((u) => Math.abs(u - ly) < 13)) ly += 14;
    usedLabelYs.push(ly);
    out += text(w - padR, ly, s.label, { anchor: 'end', size: 10.5, color, weight: 600 });
  });
  xLabels.forEach((l, i) => { out += text(x(i), h - 10, l, { anchor: i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle', size: 10 }); });
  return frame(w, h, out);
}

/**
 * Horizontal stacked bars. rows: [{ label, segments: [{ label, value, kind }] }]
 * kind: 'recovered'|'calendar'|'active' — validated order green|neutral|red.
 */
const STACK_COLOR = { recovered: C.success, calendar: C.gray, active: C.critical };
function stackedBarsH({ w = 660, rows, unit = '' }) {
  const rowH = 34; const gap = 14; const padL = 74; const padR = 14; const padT = 8;
  const h = padT + rows.length * (rowH + gap) + 26;
  const max = Math.max(...rows.map((r) => r.segments.reduce((s, g) => s + g.value, 0)));
  const scale = (v) => (v / max) * (w - padL - padR);
  let out = '';
  rows.forEach((r, ri) => {
    const y = padT + ri * (rowH + gap);
    out += text(padL - 8, y + rowH / 2 + 4, r.label, { anchor: 'end', color: C.ink, weight: 600, size: 12 });
    let cx = padL;
    r.segments.forEach((g) => {
      if (g.value <= 0) return;
      const bw = scale(g.value);
      out += `<rect x="${cx}" y="${y}" width="${Math.max(bw - 2, 1)}" height="${rowH}" rx="4" fill="${STACK_COLOR[g.kind] || C.gray}"><title>${esc(`${r.label} · ${g.label}: ${fmt(g.value)}${unit}`)}</title></rect>`;
      if (bw > 44) out += text(cx + (bw - 2) / 2, y + rowH / 2 + 4, fmt(g.value), { anchor: 'middle', color: '#ffffff', weight: 600, size: 11 });
      cx += bw;
    });
  });
  const legendKinds = [...new Set(rows.flatMap((r) => r.segments.map((g) => `${g.kind}::${g.label}`)))];
  let lx = padL;
  const ly = h - 8;
  for (const lk of legendKinds) {
    const [kind, label] = lk.split('::');
    out += `<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${STACK_COLOR[kind] || C.gray}"/>`;
    out += text(lx + 14, ly, label, { size: 10.5 });
    lx += 14 + label.length * 5.6 + 22;
  }
  return frame(w, h, out);
}

/** Vertical histogram; each bin carries a status hue; identity is the axis. */
function histogram({ w = 660, h = 210, bins, note }) {
  const padL = 34; const padR = 14; const padT = 16; const padB = 28;
  const max = Math.max(...bins.map((b) => b.count));
  const bw = (w - padL - padR) / bins.length;
  let out = '';
  bins.forEach((b, i) => {
    const bh = (b.count / max) * (h - padT - padB);
    const x0 = padL + i * bw + 3;
    const y0 = h - padB - bh;
    out += `<rect x="${x0}" y="${y0}" width="${bw - 6}" height="${bh}" rx="4" fill="${C[b.status] || C.gray}"><title>${esc(`${b.label}: ${b.count}`)}</title></rect>`;
    out += text(x0 + (bw - 6) / 2, y0 - 5, String(b.count), { anchor: 'middle', size: 10.5, color: C.ink, weight: 600 });
    out += text(x0 + (bw - 6) / 2, h - 10, b.label, { anchor: 'middle', size: 10 });
  });
  if (note) out += text(w - padR, padT, note, { anchor: 'end', size: 10.5 });
  return frame(w, h, out);
}

/**
 * Hour profile — TWO ALIGNED PANELS sharing the hour axis (never dual-axis):
 * spend bars above, cost-per-result line below. flagged hours marked red.
 */
function hourProfile({ w = 660, hours, flagged = [], currency = '$' }) {
  const padL = 52; const padR = 14; const p1T = 18; const p1B = 118; const p2T = 142; const p2B = 236; const h = 262;
  const bw = (w - padL - padR) / 24;
  const maxSpend = Math.max(...hours.map((r) => r.spend));
  let out = '';
  out += text(padL, 12, `Spend by hour (${currency})`, { size: 10.5, weight: 600, color: C.ink });
  hours.forEach((r) => {
    const bh = (r.spend / maxSpend) * (p1B - p1T);
    const flaggedHour = flagged.includes(r.hour);
    out += `<rect x="${padL + r.hour * bw + 1.5}" y="${p1B - bh}" width="${bw - 3}" height="${bh}" rx="3" fill="${flaggedHour ? C.criticalTint : 'rgba(0,0,0,0.10)'}" stroke="${flaggedHour ? C.critical : 'none'}" stroke-width="${flaggedHour ? 1 : 0}"><title>${esc(`${String(r.hour).padStart(2, '0')}:00 · spend ${currency}${fmt(r.spend)}`)}</title></rect>`;
  });
  out += text(padL, p2T - 8, `Cost per result by hour (${currency})`, { size: 10.5, weight: 600, color: C.ink });
  const cpas = hours.map((r) => r.cpa).filter((v) => v != null);
  const ys = scaleY(cpas, p2T, p2B);
  const pts = hours.filter((r) => r.cpa != null);
  const x = (hour) => padL + hour * bw + bw / 2;
  const d = pts.map((r, i) => `${i ? 'L' : 'M'} ${x(r.hour)} ${ys.y(r.cpa)}`).join(' ');
  out += gridLines(padL, w - padR, p2T, p2B, ys, 2);
  out += `<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="2" stroke-linejoin="round"/>`;
  for (const r of pts) {
    const bad = flagged.includes(r.hour);
    out += marker('circle', x(r.hour), ys.y(r.cpa), bad ? C.critical : C.ink);
    if (bad) out += text(x(r.hour), ys.y(r.cpa) - 8, `${String(r.hour).padStart(2, '0')}:00 · ${currency}${fmt(r.cpa)}`, { anchor: 'middle', size: 10, color: C.critical, weight: 600 });
  }
  for (let hh = 0; hh < 24; hh += 4) out += text(padL + hh * bw + bw / 2, h - 8, String(hh).padStart(2, '0'), { anchor: 'middle', size: 10 });
  return frame(w, h, out);
}

/** Share-of-available horizontal bars: filled vs track, % labeled. */
function shareBars({ w = 660, rows }) {
  const rowH = 26; const gap = 14; const padL = 74; const padR = 60; const padT = 6;
  const h = padT + rows.length * (rowH + gap) + 8;
  let out = '';
  rows.forEach((r, i) => {
    const y = padT + i * (rowH + gap);
    const trackW = w - padL - padR;
    out += text(padL - 8, y + rowH / 2 + 4, r.label, { anchor: 'end', color: C.ink, weight: 600, size: 12 });
    out += `<rect x="${padL}" y="${y}" width="${trackW}" height="${rowH}" rx="4" fill="rgba(0,0,0,0.06)"/>`;
    out += `<rect x="${padL}" y="${y}" width="${Math.max((r.pct / 100) * trackW, 2)}" height="${rowH}" rx="4" fill="${C.ink}"><title>${esc(`${r.label}: ${r.pct}%`)}</title></rect>`;
    out += text(padL + (r.pct / 100) * trackW + 8, y + rowH / 2 + 4, `${r.pct}%`, { size: 11, color: C.ink, weight: 600 });
  });
  return frame(w, h, out);
}

module.exports = { lineChart, stackedBarsH, histogram, hourProfile, shareBars, CHART_COLORS: C };
