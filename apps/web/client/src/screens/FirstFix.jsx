// Funnel stage 9 — the first-fix ceremony. ONE finding, before/after, one
// Approve. The write-scope ask happens here, at the moment of intent (§6).
import React, { useEffect, useState } from 'react';
import { ArrowDown, ShieldCheck, Undo2 } from 'lucide-react';
import { api, isDemo } from '../lib/api.js';
import { useRouter } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote } from '../lib/ui.jsx';

export default function FirstFix() {
  const { navigate } = useRouter();
  const [fix, setFix] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/app/first-fix').then((d) => setFix(d.fix)).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (fix === undefined) return <Spinner label="Preparing your first fix" />;
  if (!fix) {
    return (
      <div className="mx-auto max-w-m2 px-5 pt-14">
        <EmptyState
          title="No fixes waiting right now"
          body="Your next weekly check will bring anything worth fixing straight here."
          cta={<Button onClick={() => navigate('/app')}>Back to your dashboard</Button>}
        />
      </div>
    );
  }

  async function approve() {
    setBusy(true);
    try {
      await api(`/api/app/approve/${fix.change_id}`, { method: 'POST' });
      navigate('/app/approvals');
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-12">
      <MonoLabel>Your first fix · one tap</MonoLabel>
      <h1 className="mt-2 text-h2 tracking-tight">{fix.finding_title}</h1>
      <p className="mt-2 max-w-[54ch] text-body text-neutral-900">{fix.explanation}</p>

      <div className="mt-6 flex flex-col gap-2">
        <Card className="p-5" accent="critical">
          <MonoLabel>Now</MonoLabel>
          <p className="mt-1 text-body">{fix.before_line}</p>
        </Card>
        <div className="flex justify-center text-neutral-800"><ArrowDown size={18} aria-hidden /></div>
        <Card className="p-5" accent="success">
          <MonoLabel>After your approval</MonoLabel>
          <p className="mt-1 text-body">{fix.after_line}</p>
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <p className="text-small text-neutral-900">
            We watch for 48 hours after applying it and send you a receipt when the numbers hold.
          </p>
        </div>
        <div className="mt-2 flex items-start gap-2.5">
          <Undo2 size={17} className="mt-0.5 shrink-0 text-neutral-900" aria-hidden />
          <p className="text-small text-neutral-900">Changed your mind later? One tap puts everything back exactly as it was.</p>
        </div>
      </Card>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button onClick={approve} disabled={busy} className="sm:min-w-[220px]">
          {busy ? 'Approving…' : 'Approve this fix'}
        </Button>
        <Button variant="ghost" onClick={() => navigate('/app')}>Not now</Button>
      </div>
      {!isDemo() && (
        <p className="mt-3 text-tiny text-neutral-900">
          First approval? Google will ask once for permission to make fixes —{' '}
          <a href="/auth/google/start?step=write" className="underline underline-offset-2">grant fix access</a>.
        </p>
      )}
    </div>
  );
}
