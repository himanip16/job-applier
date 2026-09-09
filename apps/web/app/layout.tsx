import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { LayoutContent } from './layout-content';

export const metadata: Metadata = {
  title: 'Job Applier',
  description: 'Find, apply, tailor and track — with an answer bank that learns.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/*
        * Browser extensions stamp attributes on <body> - a theme switcher adds
        * data-rm-theme - between the server HTML arriving and React hydrating,
        * which React reports as a hydration mismatch the app cannot fix. This
        * suppresses the warning for this element's own attributes only;
        * mismatches in anything rendered inside still surface normally.
        */}
      <body suppressHydrationWarning>
        <LayoutContent>{children}</LayoutContent>
      </body>
    </html>
  );
}
