// Plans (gated-platform spec §3). The Plan sheet is the funnel; this page is
// the same offer laid out in full for anyone who wants to read it first, and
// the place Settings' "Change plan" lands. Prices come with the gate
// (/api/app/access) from pricing_config for the tenant's band.
import React from 'react';
import { MonoLabel, Card } from '../lib/ui.jsx';
import { useAccess } from '../lib/access.jsx';
import { PlanOffer } from '../lib/plan-sheet.jsx';

export default function Plan() {
  const { access, level } = useAccess();
  const kicker = level === 'active' && access && access.plan ? `Your plan: ${access.plan.label}` : access && access.credit_applies ? 'Your $20 audit is credited to month one' : 'Plans';
  return (
    <div className="mx-auto max-w-l2 px-5 pb-24 pt-12">
      <MonoLabel>{kicker}</MonoLabel>
      <h1 className="mt-2 text-h2 tracking-tight">Keep it fixed, every week.</h1>
      <p className="mt-2 max-w-[52ch] text-body text-neutral-900">
        The audit found the problems. A plan keeps finding them, and fixes what you approve, week after week.
      </p>
      <Card className="mt-6">
        <PlanOffer inline initialCompare />
      </Card>
    </div>
  );
}
