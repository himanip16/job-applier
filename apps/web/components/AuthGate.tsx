'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';

/**
 * Nothing renders until we know who is asking.
 *
 * The server is the real guard - every /api path refuses a stranger - so this
 * is not the security boundary. It exists so a signed-out visitor sees a sign-in
 * page instead of a full dashboard whose every panel has failed with 401.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<'checking' | 'allowed' | 'redirecting'>('checking');

  useEffect(() => {
    if (pathname?.startsWith('/signin')) {
      setState('allowed');
      return;
    }
    let live = true;
    api<{ user: { email: string } | null }>('/api/auth/me')
      .then((d) => {
        if (!live) return;
        if (d.user) {
          setState('allowed');
          return;
        }
        setState('redirecting');
        const here = window.location.pathname + window.location.search;
        window.location.href = `/signin?next=${encodeURIComponent(here)}`;
      })
      .catch(() => {
        // The API is unreachable, which is a different problem from being
        // signed out. Let the page render and report its own error rather
        // than bouncing to a sign-in form that also cannot reach the server.
        if (live) setState('allowed');
      });
    return () => {
      live = false;
    };
  }, [pathname]);

  if (state !== 'allowed') return null;
  return <>{children}</>;
}
