'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';

/**
 * Who you are signed in as, and the way out.
 *
 * Deliberately just an avatar until you click it. Spelled out in full, an
 * email address is a couple of hundred pixels of chrome that never changes
 * and that nobody reads twice - and it was taking those pixels from the nav,
 * which then had to wrap onto a second line. Identity is a thing you check
 * occasionally; navigation is a thing you use constantly, so navigation wins
 * the space and the address moves one click away.
 */
export function AccountMenu() {
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pathname?.startsWith('/signin')) {
      setEmail(null);
      return;
    }
    api<{ user: { email: string } | null }>('/api/auth/me')
      .then((d) => setEmail(d.user?.email ?? null))
      .catch(() => setEmail(null));
  }, [pathname]);

  // Close on an outside click or Escape, the two things a person tries.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!email) return null;

  return (
    <div ref={box} className="account">
      <button
        className="account-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email}
      >
        <span className="account-avatar" aria-hidden="true">
          {email[0]?.toUpperCase()}
        </span>
        <span className="account-caret" aria-hidden="true" />
        <span className="sr-only">Account: {email}</span>
      </button>

      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-head">
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Signed in as
            </div>
            <div className="truncate" title={email}>
              {email}
            </div>
          </div>
          <a className="account-menu-item" href="/settings" role="menuitem">
            Keys and settings
          </a>
          <a className="account-menu-item" href="/profile" role="menuitem">
            Your profile
          </a>
          <button
            className="account-menu-item danger"
            role="menuitem"
            onClick={async () => {
              await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
              window.location.href = '/signin';
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
