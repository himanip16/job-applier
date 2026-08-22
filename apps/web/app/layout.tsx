import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Job Applier',
  description: 'Assisted job applications with an answer bank that learns.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <strong>Job Applier</strong>
            <nav>
              <a href="/discover">Find work</a>
              <a href="/">Runs</a>
              <a href="/tracker">Tracker</a>
              <a href="/resume">Resume</a>
              <a href="/retro">Retrospective</a>
              <a href="/profile">Profile</a>
              <a href="/answers">Answers</a>
            </nav>
          </div>
        </header>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
