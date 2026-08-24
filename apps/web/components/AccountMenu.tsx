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
    <div className="row" style={{ gap: '.5rem', flex: 'none' }}>
      <span
        className="small muted"
        title={email}
        style={{
          maxWidth: '11rem',
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
