'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';

/** Who you are signed in as, and the way out. */
export function AccountMenu() {
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (pathname?.startsWith('/signin')) {
      setEmail(null);
      return;
    }
    api<{ user: { email: string } | null }>('/api/auth/me')
      .then((d) => setEmail(d.user?.email ?? null))
      .catch(() => setEmail(null));
  }, [pathname]);

  if (!email) return null;

  return (
    <div
      className="row"
      style={{
        gap: '.6rem',
        flex: 'none',
        // A divider and its own padding, rather than sitting flush against
        // the last nav item - the two are unrelated (one is "where", the
        // other is "who"), and running them together read as cramped.
        borderLeft: '1px solid var(--border)',
        paddingLeft: '.85rem',
        marginLeft: '.15rem',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: 'none',
          width: '1.6rem',
          height: '1.6rem',
          borderRadius: '999px',
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '.72rem',
          fontWeight: 700,
        }}
      >
        {email[0]?.toUpperCase()}
      </span>
      <span
        className="small muted"
        title={email}
        style={{
          maxWidth: '13rem',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {email}
      </span>
      <button
        className="ghost small"
        onClick={async () => {
          await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
          window.location.href = '/signin';
        }}
      >
        Sign out
      </button>
    </div>
  );
}
