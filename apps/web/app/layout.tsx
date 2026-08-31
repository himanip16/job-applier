import './globals.css';
import type { ReactNode } from 'react';
import { ErrorProvider } from '../contexts/ErrorContext';
import { LayoutContent } from './layout-content';

export const metadata = {
  title: 'Job Applier',
  description: 'Find, apply, tailor, track, and do LinkedIn outreach — with an answer bank that learns.',
};

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
