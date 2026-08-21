// Funnel stage 5 - discovery confirmation (§7): matched cards pre-ticked,
// unmatched collapsed, ONE action. Never a configuration form.
import React, { useEffect, useState } from 'react';
import { CheckCircle as CheckCircle2, ChevronDown } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { useRouter } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, ErrorNote } from '../lib/ui.jsx';

const KIND_LABEL = {
  ads_account: 'Your ads account',
  ga4_property: 'Your analytics',
  ga4_stream: 'Your visit counter',
  gtm_container: 'Your tracking',
};

export default function Confirm() {
  const { navigate } = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showOther, setShowOther] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/app/discovery').then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!data) return <Spinner label="Reading what your Google account can reach" />;

  async function confirm() {
    setBusy(true);
    try {
      await api('/api/app/confirm', { method: 'POST' });
      navigate('/app');
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-12">
      <MonoLabel>One tap and the check begins</MonoLabel>
      <h1 className="mt-2 text-h2 tracking-tight">We found your setup.</h1>
      <p className="mt-2 max-w-[52ch] text-body text-neutral-900">
        These match your website - the tracking on your pages told us. Nothing to configure.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {data.matched.map((a) => (
          <Card key={a.id} className="flex items-center justify-between gap-3 p-4" accent="success">
            <div>
              <MonoLabel>{KIND_LABEL[a.kind] || a.kind}</MonoLabel>
              <div className="mt-0.5 text-body font-medium">{a.display_name || a.external_id}</div>
            </div>
            <CheckCircle2 size={18} className="shrink-0 text-success" aria-label="Matched to your site" />
          </Card>
        ))}
      </div>

      {data.unmatched.length > 0 && (
        <div className="mt-4">
          <button type="button" onClick={() => setShowOther(!showOther)} className="flex items-center gap-1.5 text-small text-neutral-900 underline underline-offset-2">
            <ChevronDown size={14} className={showOther ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden />
            {data.unmatched.length} other item{data.unmatched.length === 1 ? '' : 's'} we can see but didn’t match your site
          </button>
          {showOther && (
            <div className="mt-3 flex flex-col gap-2">
              {data.unmatched.map((a) => (
                <Card key={a.id} className="p-4 opacity-70">
                  <MonoLabel>{KIND_LABEL[a.kind] || a.kind}</MonoLabel>
                  <div className="mt-0.5 text-small">{a.display_name || a.external_id}</div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      <Button onClick={confirm} disabled={busy} className="mt-8 w-full sm:w-auto">
        {busy ? 'Starting your check…' : 'Yes - run my free check'}
      </Button>
      <p className="mt-3 text-tiny text-neutral-900">Still read-only. Your report arrives in a few minutes.</p>
    </div>
  );
}
