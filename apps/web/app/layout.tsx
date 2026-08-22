import './globals.css';
import type { ReactNode } from 'react';
import { Nav } from '../components/Nav';

export const metadata = {
  title: 'Job Applier',
  description: 'Find, apply, tailor and track — with an answer bank that learns.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <a href="/" style={{ color: 'inherit', textDecoration: 'none' }}>
              <strong>Job Applier</strong>
            </a>
            <Nav />
          </div>
        </header>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
