// Tiny history router for the /app SPA. No dependency needed for 12 routes.
import React, { createContext, useContext, useEffect, useState } from 'react';
import { demoHref } from './api.js';

const RouterCtx = createContext({ path: '/app', navigate: () => {} });

export function RouterProvider({ children }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to) => {
    window.history.pushState({}, '', demoHref(to));
    setPath(to.split('?')[0]);
    window.scrollTo(0, 0);
  };
  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>;
}

export const useRouter = () => useContext(RouterCtx);

export function Link({ to, children, className }) {
  const { navigate } = useRouter();
  return (
    <a
      href={demoHref(to)}
      className={className}
      onClick={(e) => { e.preventDefault(); navigate(to); }}
    >
      {children}
    </a>
  );
}
