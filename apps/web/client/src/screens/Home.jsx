// Dashboard home - §11 screen 2. Health, waiting approvals, cumulative value,
// latest report. Every element leads somewhere; empty states sell next steps.
import React, { useEffect, useState } from 'react';
import { ArrowRight, Zap } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote, Sparkline, useCountUp } from '../lib/ui.jsx';

function MiniDial({ score }) {
  const sevColor = score < 50 ? '#DC2626' : score < 70 ? '#D97706' : '#16A34A';
  const r = 40; const cx = 50; const cy = 50; const start = 135; const sweepMax = 270;
  const arc = (from, deg) => {
    const rad = (a) => ((a - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(from)); const y1 = cy + r * Math.sin(rad(from));
    const x2 = cx + r * Math.cos(rad(from + deg)); const y2 = cy + r * Math.sin(rad(from + deg));
    return `M ${x1} ${y1} A ${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const shown = useCountUp(score);
  return (
    <div className="relative h-[100px] w-[100px] shrink-0" role="img" aria-label={`Account health ${score} out of 100`}>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <path d={arc(start, sweepMax)} fill="none" stroke="#f2f2f2" strokeWidth="7" strokeLinecap="round" />
        <path d={arc(start, Math.max((shown / 100) * sweepMax, 3))} fill="none" stroke={sevColor} strokeWidth="7" strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-h4">{shown}</div>
    </div>
  );
}

function WasteFigure({ value }) {
  const shown = useCountUp(value);
  return (
    <div className="mt-1 text-h3">
      ${shown.toLocaleString()}<span className="text-small text-neutral-900">/mo</span>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/app/home').then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!data) return <Spinner label="Loading your account" />;

  const { health, pending, cumulative, reports, streak, plan } = data;
  const latest = reports && reports[0];
  const trend = (health.trend || []).map((p) => (typeof p === 'number' ? p : p.score));
  const delta = trend.length >= 2 ? trend[trend.length - 1] - trend[trend.length - 2] : null;
  const showGraduation = (streak || 0) >= 10 && plan && plan.tier === 'core';

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <Card className="flex items-center gap-5 p-5">
        <MiniDial score={health.score} />
        <div className="min-w-0 flex-1">
          <MonoLabel>Account health</MonoLabel>
          <div className="mt-0.5 text-h5">
            {health.score < 50 ? 'Needs work - fixes waiting below.' : health.score < 70 ? 'Getting better every week.' : 'Healthy - we keep watch.'}
          </div>
          {latest && (
            <Link to={`/app/report/${latest.id}`} className="mt-1 inline-flex items-center gap-1 text-small underline underline-offset-2">
              Latest report <ArrowRight size={13} aria-hidden />
            </Link>
          )}
        </div>
        {trend.length >= 2 && (
          <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
            <Sparkline points={trend} />
            {delta !== null && delta !== 0 && (
              <span className={`font-mono text-tiny ${delta > 0 ? 'text-success' : 'text-critical'}`}>
                {delta > 0 ? '+' : ''}{delta} since last report
              </span>
            )}
          </div>
        )}
      </Card>

      {showGraduation && (
        <Card accent="info" className="mt-3 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Zap size={17} className="mt-0.5 shrink-0 text-info" aria-hidden />
            <div>
              <div className="text-body font-semibold">You&apos;ve said yes {streak} times in a row.</div>
              <div className="mt-0.5 text-small text-neutral-900">
                Autopilot applies these same safe fixes for you and tells you after - you keep the one-tap undo on every change.
              </div>
            </div>
          </div>
          <Link to="/app/plan" className="shrink-0"><Button variant="secondary" className="!px-4 !py-2">See Autopilot</Button></Link>
        </Card>
      )}

      {cumulative && (cumulative.fixes > 0 || cumulative.waste_removed_usd > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Card className="p-4">
            <MonoLabel>Fixes applied</MonoLabel>
            <div className="mt-1 text-h3">{cumulative.fixes}</div>
          </Card>
          <Card className="p-4">
            <MonoLabel>Waste removed</MonoLabel>
            <WasteFigure value={cumulative.waste_removed_usd} />
          </Card>
        </div>
      )}

      {plan && (
        <div className="mt-3 flex items-center justify-between rounded border border-neutral-300 bg-neutral-50 px-4 py-2.5 text-small text-neutral-900">
          <span>
            {plan.label} plan · sized for accounts around {plan.band === '25k' ? '25,000' : plan.band === '10k' ? '10,000' : '4,000'} search terms
          </span>
          <Link to="/app/settings" className="underline underline-offset-2">Manage</Link>
        </div>
      )}

      <div className="mt-8">
        <div className="flex items-end justify-between">
          <h2 className="text-h4">Waiting for your yes</h2>
          {pending.length > 0 && <Link to="/app/approvals" className="text-small underline underline-offset-2">See all</Link>}
        </div>
        {pending.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="Nothing waiting" body="Your next weekly check will bring anything worth fixing straight here." />
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {pending.slice(0, 3).map((p, i) => (
              <Card key={p.id} className="rise lift flex items-center justify-between gap-3 p-4" style={{ '--rise-i': i }}>
                <div>
                  <div className="text-body font-medium">{p.title}</div>
                  {p.money_line && <div className="mt-0.5 text-small text-neutral-900">{p.money_line}</div>}
                </div>
                <Link to="/app/approvals"><Button variant="secondary" className="!px-4 !py-2">Review</Button></Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
