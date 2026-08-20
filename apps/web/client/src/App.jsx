// The /app SPA — shell, routes, session gate.
// Public routes (no session): /app/start, /app/report (sample).
// Everything else asks /api/app; a 401 lands on the sign-in view.

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Home as HomeIcon, CheckSquare, ScrollText, FileText, Settings as SettingsIcon, Map } from 'lucide-react';
import { RouterProvider, useRouter, Link } from './lib/router.jsx';
import { api, isDemo } from './lib/api.js';
import { MonoLabel, Button, Spinner } from './lib/ui.jsx';
import Start from './screens/Start.jsx';
import Confirm from './screens/Confirm.jsx';
import Plan from './screens/Plan.jsx';
import FirstFix from './screens/FirstFix.jsx';
import Home from './screens/Home.jsx';
import Approvals from './screens/Approvals.jsx';
import Ledger from './screens/Ledger.jsx';
import Reports from './screens/Reports.jsx';
import Journey from './screens/Journey.jsx';
import Settings from './screens/Settings.jsx';
import Report from './report/Report.jsx';
import Agency from './agency/Agency.jsx';

const NAV = [
  { to: '/app', label: 'Home', icon: HomeIcon },
  { to: '/app/approvals', label: 'Approvals', icon: CheckSquare },
  { to: '/app/reports', label: 'Reports', icon: FileText },
  { to: '/app/ledger', label: 'Ledger', icon: ScrollText },
  { to: '/app/journey', label: 'Setup', icon: Map },
  { to: '/app/settings', label: 'Settings', icon: SettingsIcon },
];

const PUBLIC = new Set(['/app/start', '/app/report']);

function SignIn() {
  return (
    <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
      <MonoLabel>Insyt</MonoLabel>
      <h1 className="mt-2 text-h2 tracking-tight">Sign in</h1>
      <p className="mt-2 text-body text-neutral-900">
        The one-tap links in your Insyt emails sign you straight in. New here? Start with your free check.
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <Button href="/app/start">Run my free check</Button>
        <Button variant="secondary" href="/auth/google/start?step=discovery">Continue with Google</Button>
      </div>
      <p className="mt-4 text-tiny text-neutral-900">Read-only until you approve a fix. Nothing changes without your yes.</p>
    </div>
  );
}

function Frame({ children, withNav }) {
  const { path } = useRouter();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-neutral-300 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-l2 items-center justify-between px-5 py-4">
          <Link to="/app" className="text-h5 font-semibold tracking-tight">Insyt</Link>
          {isDemo() && <MonoLabel>Preview with sample data</MonoLabel>}
        </div>
      </header>
      <div className={withNav ? 'pb-20' : ''}>{children}</div>
      {withNav && (
        <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-300 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur" aria-label="Main">
          <div className="mx-auto flex max-w-l2 items-stretch justify-between px-2">
            {NAV.map(({ to, label, icon: IconEl }) => {
              const active = path === to;
              return (
                <Link
                  key={to}
                  to={to}
                  className={clsx(
                    'flex flex-1 flex-col items-center gap-1 py-2.5 font-mono text-tiny uppercase tracking-wide',
                    active ? 'text-accent' : 'text-neutral-900',
                  )}
                >
                  <IconEl size={17} strokeWidth={active ? 2.4 : 1.8} aria-hidden />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}

function Routes() {
  const { path } = useRouter();
  const [authed, setAuthed] = useState(null); // null = checking

  const isAgency = path.startsWith('/app/agency');
  const needsSession = !PUBLIC.has(path) && !isAgency;

  useEffect(() => {
    if (!needsSession || isDemo()) { setAuthed(true); return; }
    api('/api/app/journey').then(() => setAuthed(true)).catch((e) => setAuthed(e.status !== 401));
  }, [path, needsSession]);

  // Agency console owns its shell and auth (seat check via /api/agency/me).
  if (isAgency) return <Agency />;

  if (path === '/app/start') return <Frame><Start /></Frame>;
  if (path === '/app/report') return <Frame><Report /></Frame>;

  if (authed === null) return <Frame><Spinner label="One moment" /></Frame>;
  if (!authed) return <Frame><SignIn /></Frame>;

  if (path === '/app/confirm') return <Frame><Confirm /></Frame>;
  if (path === '/app/plan') return <Frame withNav><Plan /></Frame>;
  if (path === '/app/first-fix') return <Frame><FirstFix /></Frame>;
  if (path.startsWith('/app/report/')) return <Frame withNav><Report reportId={path.split('/')[3]} /></Frame>;
  if (path === '/app/approvals') return <Frame withNav><Approvals /></Frame>;
  if (path === '/app/ledger') return <Frame withNav><Ledger /></Frame>;
  if (path === '/app/reports') return <Frame withNav><Reports /></Frame>;
  if (path === '/app/journey') return <Frame withNav><Journey /></Frame>;
  if (path === '/app/settings') return <Frame withNav><Settings /></Frame>;
  return <Frame withNav><Home /></Frame>;
}

export default function App() {
  return (
    <RouterProvider>
      <Routes />
    </RouterProvider>
  );
}
