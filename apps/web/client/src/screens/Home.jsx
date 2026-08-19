// Dashboard home — §11 screen 2. Health, waiting approvals, cumulative value,
// latest report. Every element leads somewhere; empty states sell next steps.
import React, { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote } from '../lib/ui.jsx';

function MiniDial({ score }) {
  const sevColor = score < 50 ? '#DC2626' : score < 70 ? '#D97706' : '#16A34A';
  const r = 40; const cx = 50; const cy = 50; const start = 135; const sweepMax = 270;
  const arc = (from, deg) => {
    const rad = (a) => ((a - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(from)); const y1 = cy + r * Math.sin(rad(from));
    const x2 = cx + r * Math.cos(rad(from + deg)); const y2 = cy + r * Math.sin(rad(from + deg));
    return `M ${x1} ${y1} A ${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  return (
    <div className="relative h-[100px] w-[100px] shrink-0" role="img" aria-label={`Account health ${score} out of 100`}>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <path d={arc(start, sweepMax)} fill="none" stroke="#f2f2f2" strokeWidth="7" strokeLinecap="round" />
        <path d={arc(start, Math.max((score / 100) * sweepMax, 3))} fill="none" stroke={sevColor} strokeWidth="7" strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-h4">{score}</div>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/app/home').then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!data) return <Spinner label="Loading your account" />;

  const { health, pending, cumulative, reports } = data;
  const latest = reports && reports[0];

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <Card className="flex items-center gap-5 p-5">
        <MiniDial score={health.score} />
        <div>
          <MonoLabel>Account health</MonoLabel>
          <div className="mt-0.5 text-h5">
            {health.score < 50 ? 'Needs work — fixes waiting below.' : health.score < 70 ? 'Getting better every week.' : 'Healthy — we keep watch.'}
          </div>
          {latest && (
            <Link to={`/app/report/${latest.id}`} className="mt-1 inline-flex items-center gap-1 text-small underline underline-offset-2">
              Latest report <ArrowRight size={13} aria-hidden />
            </Link>
          )}
        </div>
      </Card>

      {cumulative && (cumulative.fixes > 0 || cumulative.waste_removed_usd > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Card className="p-4">
            <MonoLabel>Fixes applied</MonoLabel>
            <div className="mt-1 text-h3">{cumulative.fixes}</div>
          </Card>
          <Card className="p-4">
            <MonoLabel>Waste removed</MonoLabel>
            <div className="mt-1 text-h3">${cumulative.waste_removed_usd.toLocaleString()}<span className="text-small text-neutral-900">/mo</span></div>
          </Card>
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
            {pending.slice(0, 3).map((p) => (
              <Card key={p.id} className="flex items-center justify-between gap-3 p-4">
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
