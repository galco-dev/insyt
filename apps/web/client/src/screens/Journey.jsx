// Journey screen - §11/§9. Gates as a checklist; one instruction at a time.
import React, { useEffect, useState } from 'react';
import { CheckCircle as CheckCircle2, Circle } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { MonoLabel, Card, Spinner, ErrorNote } from '../lib/ui.jsx';

const GATE_LABEL = {
  tag: 'Tracking installed and verified',
  approval: 'Campaigns reviewed and approved',
  billing: 'Ad money connected to Google',
};

export default function Journey() {
  const [journey, setJourney] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/app/journey').then((d) => setJourney(d.journey)).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!journey) return <Spinner label="Loading your setup" />;

  const gates = journey.gates || {};

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Your setup</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Getting you live</h1>

      <Card className="mt-6 p-5" accent="info">
        <MonoLabel>Next step</MonoLabel>
        <p className="mt-1 text-h5">{journey.instruction_line}</p>
      </Card>

      <Card className="mt-3 divide-y divide-neutral-200">
        {Object.entries(GATE_LABEL).map(([key, label]) => {
          const done = !!gates[key];
          const IconEl = done ? CheckCircle2 : Circle;
          return (
            <div key={key} className="flex items-center gap-3 p-4">
              <IconEl size={17} className={done ? 'shrink-0 text-success' : 'shrink-0 text-neutral-700'} aria-hidden />
              <span className={done ? 'text-body' : 'text-body text-neutral-900'}>{label}</span>
              {done && <span className="ml-auto font-mono text-tiny uppercase tracking-[0.1em] text-success">Done</span>}
            </div>
          );
        })}
      </Card>

      <p className="mt-4 text-tiny text-neutral-900">
        We check automatically at every step - there is nothing to confirm from your side.
      </p>
    </div>
  );
}
