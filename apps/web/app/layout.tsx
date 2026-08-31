'use client';

import './globals.css';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Nav } from '../components/Nav';
import { NeedsYou } from '../components/NeedsYou';
import { AuthGate } from '../components/AuthGate';
import { AccountMenu } from '../components/AccountMenu';
import { ErrorProvider } from '../contexts/ErrorContext';
import { RateLimitModal } from '../components/RateLimitModal';
import { useError } from '../contexts/ErrorContext';
import { setRateLimitModalHandler } from '../lib/api';

export const metadata = {
  title: 'Job Applier',
  description: 'Find, apply, tailor and track — with an answer bank that learns.',
};

function LayoutContent({ children }: { children: ReactNode }) {
  const { rateLimitError, showRateLimitModal, hideRateLimitModal } = useError();

  useEffect(() => {
    setRateLimitModalHandler(showRateLimitModal);
  }, [showRateLimitModal]);

  return (
    <>
      <header className="top">
        <div className="inner">
          <a href="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 3 5 13.5h6L11 21l8-10.5h-6z" />
              </svg>
            </span>
            Job Applier
          </a>
          <Nav />
          <AccountMenu />
        </div>
      </header>
      <AuthGate>
        <NeedsYou />
        <div className="wrap">{children}</div>
      </AuthGate>
      <RateLimitModal
        isOpen={rateLimitError !== null}
        onClose={hideRateLimitModal}
        provider={rateLimitError?.provider ?? null}
      />
    </>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorProvider>
          <LayoutContent>{children}</LayoutContent>
        </ErrorProvider>
      </body>
    </html>
  );
}
