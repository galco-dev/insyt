// Report archive — §11. Every report ever, newest first.
import React, { useEffect, useState } from 'react';
import { FileText, ArrowRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { MonoLabel, Card, Spinner, EmptyState, ErrorNote } from '../lib/ui.jsx';

const TYPE_LABEL = { weekly: 'Weekly report', audit: 'Your audit', deep: 'Deep review', monthly: 'Monthly pulse' };

export default function Reports() {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api('/api/app/reports').then((d) => setReports(d.reports)).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!reports) return <Spinner label="Loading reports" />;

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      <MonoLabel>Your history, kept forever</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Reports</h1>

      {reports.length === 0 ? (
        <div className="mt-6"><EmptyState title="Your first report is on its way" body="Reports land here every week — and stay here." /></div>
      ) : (
        <Card className="mt-6 divide-y divide-neutral-200">
          {reports.map((r) => (
            <Link key={r.id} to={`/app/report/${r.id}`} className="flex items-center gap-3 p-4 hover:bg-neutral-50">
              <FileText size={16} className="shrink-0 text-neutral-900" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">{TYPE_LABEL[r.type] || r.type}</div>
                <div className="mt-0.5 font-mono text-tiny text-neutral-900">
                  {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  {!r.viewed_at && <span className="ml-2 rounded-full bg-info-tint px-2 py-0.5 text-info">New</span>}
                </div>
              </div>
              <ArrowRight size={15} className="shrink-0 text-neutral-800" aria-hidden />
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
