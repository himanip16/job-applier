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
      <body>
        <LayoutContent>{children}</LayoutContent>
      </body>
    </html>
  );
}
