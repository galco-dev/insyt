// The /app SPA - shell, routes, session gate.
// Public routes (no session): /app/start, /app/report (sample).
// Everything else asks /api/app; a 401 lands on the sign-in view.

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Home01 as HomeIcon, CheckSquare, Receipt as ScrollText, Settings01 as SettingsIcon, Map01 as Map, ArrowLeft } from '@untitledui/icons';
import { RouterProvider, useRouter, Link } from './lib/router.jsx';
import { api, isDemo } from './lib/api.js';
import { MonoLabel, Button, Spinner, Wordmark, ThemeToggle, CountBadge } from './lib/ui.jsx';
import Start from './screens/Start.jsx';
import Confirm from './screens/Confirm.jsx';
import Plan from './screens/Plan.jsx';
import FirstFix from './screens/FirstFix.jsx';
import Home from './screens/Home.jsx';
import Approvals from './screens/Approvals.jsx';
import History from './screens/Ledger.jsx';
import Journey from './screens/Journey.jsx';
import Settings from './screens/Settings.jsx';
import Report from './report/Report.jsx';
import Agency from './agency/Agency.jsx';

// Four steady-state tabs: how am I doing (Home) - what needs me (Approvals) -
// what happened (History: activity + reports as lenses) - my account
// (Settings). Setup shows only during onboarding. Approvals carries the one
// "needs you" number.
const NAV = [
  { to: '/app', label: 'Home', icon: HomeIcon },
  { to: '/app/approvals', label: 'Approvals', icon: CheckSquare, badge: true },
  { to: '/app/ledger', label: 'History', icon: ScrollText, match: ['/app/ledger', '/app/reports'] },
  { to: '/app/journey', label: 'Setup', icon: Map },
  { to: '/app/settings', label: 'Settings', icon: SettingsIcon },
];

// Browser-tab titles per route. The report screen sets its own.
const TITLES = {
  '/app': 'Home - Insyt',
  '/app/approvals': 'Approvals - Insyt',
  '/app/reports': 'History - Insyt',
  '/app/ledger': 'History - Insyt',
  '/app/journey': 'Setup - Insyt',
  '/app/settings': 'Settings - Insyt',
  '/app/start': 'Free check - Insyt',
  '/app/plan': 'Plans - Insyt',
};

const PUBLIC = new Set(['/app/start', '/app/report']);

// Where "Return home" goes: the marketing site. Visitors reach the sample
// audit from tryinsyt.com and need a way back on every screen size.
const SITE_HOME = 'https://tryinsyt.com/';

// Setup auto-hide: once every gate is green the tab is a dead end, so it
// leaves the nav. Cached per session; a fresh gate change shows on reload.
let setupDonePromise = null;
function useSetupDone(enabled) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    if (!setupDonePromise) {
      setupDonePromise = api('/api/app/journey')
        .then((d) => {
          const g = d && d.journey && d.journey.gates;
          return !!(g && g.tag && g.approval && g.billing);
        })
        .catch(() => false);
    }
    let alive = true;
    setupDonePromise.then((v) => { if (alive) setDone(v); });
    return () => { alive = false; };
  }, [enabled]);
  return done;
}

// The one "needs you" number - pending approvals. Refetched on route change
// so it tracks approvals and dismissals made anywhere in the app.
function usePendingCount(enabled, path) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api('/api/app/approvals').then((d) => { if (alive) setN((d.pending || []).length); }).catch(() => {});
    return () => { alive = false; };
  }, [enabled, path]);
  return n;
}

function SignIn() {
  return (
    <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
      <span className="inline-flex justify-center"><Wordmark className="h-9" /></span>
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
  const setupDone = useSetupDone(!!withNav);
  const pending = usePendingCount(!!withNav, path);
  const items = withNav ? NAV.filter((n) => !(setupDone && n.to === '/app/journey')) : [];
  const isActive = (n) => (n.match ? n.match.includes(path) : path === n.to);
  // Sample audit / demo preview: always offer the way back to the marketing
  // site. Signed-in customers keep the normal app header.
  const returnHome = path === '/app/report' || isDemo();

  useEffect(() => {
    document.title = TITLES[path] || 'Insyt';
  }, [path]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-neutral-300 bg-page/85 backdrop-blur">
        <div className="mx-auto flex max-w-l2 items-center justify-between gap-6 px-5 py-4">
          <Link to="/app" className="flex shrink-0 items-center"><Wordmark className="h-8" /></Link>
          {/* Desktop: the nav lives up here; the bottom bar is phones only. */}
          {withNav && (
            <nav className="hidden flex-1 items-center justify-center gap-1 md:flex" aria-label="Main">
              {items.map((n) => {
                const active = isActive(n);
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    className={clsx(
                      'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-small transition-colors duration-150',
                      active
                        ? 'bg-gradient-to-b from-(--ui-plate-a) to-(--ui-plate-b) font-medium text-strong ring-1 ring-inset ring-(--ui-ring-strong)'
                        : 'text-neutral-900 hover:text-strong',
                    )}
                  >
                    {n.label}
                    {n.badge && <CountBadge n={pending} />}
                  </Link>
                );
              })}
            </nav>
          )}
          <div className="flex shrink-0 items-center gap-3">
            {isDemo() && <MonoLabel className="hidden sm:block">Preview with sample data</MonoLabel>}
            {returnHome && (
              <a
                href={SITE_HOME}
                aria-label="Return to the Insyt home page"
                className={clsx(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-small font-medium text-strong',
                  'bg-gradient-to-b from-(--ui-plate-a) to-(--ui-plate-b) ring-1 ring-inset ring-(--ui-ring-strong)',
                  'shadow-[inset_0_1px_0_var(--ui-plate-hi)] transition-[filter] duration-150 hover:brightness-110',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-focus)',
                )}
              >
                <ArrowLeft size={14} strokeWidth={2.2} aria-hidden />
                Return home
              </a>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className={clsx('page-fade', withNav && 'pb-20 md:pb-8')}>{children}</div>
      {withNav && (
        <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-300 bg-page/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Main">
          <div className="mx-auto flex max-w-l2 items-stretch justify-between px-2">
            {items.map((n) => {
              const { to, label, icon: IconEl } = n;
              const active = isActive(n);
              return (
                <Link
                  key={to}
                  to={to}
                  className={clsx(
                    'flex flex-1 flex-col items-center gap-1 py-2 font-mono text-tiny uppercase tracking-wide transition-colors duration-150',
                    active ? 'text-strong' : 'text-neutral-900',
                  )}
                >
                  <span
                    className={clsx(
                      'relative grid h-7 w-12 place-items-center rounded-full',
                      active && 'bg-gradient-to-b from-(--ui-plate-a) to-(--ui-plate-b) ring-1 ring-inset ring-(--ui-ring-strong) shadow-[inset_0_1px_0_var(--ui-plate-hi)]',
                    )}
                  >
                    <IconEl size={16} strokeWidth={active ? 2.4 : 1.8} aria-hidden />
                    {n.badge && pending > 0 && (
                      <CountBadge n={pending} className="absolute -right-1 -top-1" />
                    )}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={clsx('h-1 w-1 rounded-full bg-(--ui-cta-a) transition-opacity duration-150', active ? 'opacity-100' : 'opacity-0')}
                      style={active ? { boxShadow: '0 0 0 2px var(--ui-dot-halo)' } : undefined}
                    />
                    {label}
                  </span>
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
  if (path === '/app/ledger') return <Frame withNav><History view="activity" /></Frame>;
  if (path === '/app/reports') return <Frame withNav><History view="reports" /></Frame>;
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
