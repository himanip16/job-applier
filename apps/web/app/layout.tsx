import './globals.css';
import type { ReactNode } from 'react';
import { ErrorProvider } from '../contexts/ErrorContext';
import { LayoutContent } from './layout-content';
import { ToastProvider } from '../components/Toast';

export const metadata = {
  title: 'Job Applier',
  description: 'Find, apply, tailor, track, and do LinkedIn outreach — with an answer bank that learns.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorProvider>
          <ToastProvider>
            <LayoutContent>{children}</LayoutContent>
          </ToastProvider>
        </ErrorProvider>
      </body>
    </html>
  );
}
