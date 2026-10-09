'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useOverview } from '../lib/overview';

/**
 * Navigation that explains itself.
 *
 * A bare list of seven words tells a first-time user nothing about what this
 * app can do, so each item carries an icon, a one-line description on hover,
 * and a live count when something there needs attention. The counts are the
 * important half: a badge on "Runs" is how you find out a job application is
 * sitting waiting for an answer.
 */
const ITEMS: { href: string; label: string; hint: string; icon: ReactNode }[] = [
  {
    href: '/',
    label: 'Overview',
    hint: 'What this does, and what still needs setting up',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
      </svg>
    ),
  },
  {
    href: '/discover',
    label: 'Find work',
    hint: 'Search for openings that match you, then triage them',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    ),
  },
  {
    href: '/watchlist',
    label: 'Watch list',
    hint: 'The companies it keeps checking for new jobs',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    href: '/runs',
    label: 'Runs',
    hint: 'Applications being filled in, live',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 3 5 13.5h6L11 21l8-10.5h-6z" />
      </svg>
    ),
  },
  {
    href: '/outreach',
    label: 'Outreach',
    hint: 'Messages to people at the companies you are applying to',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 6 9 6 9-6" />
        <rect x="3" y="5" width="18" height="14" rx="2" />
      </svg>
    ),
  },
  {
    href: '/resume',
    label: 'Resume',
    hint: 'Tailor your CV for one job, ATS-safe',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3h6l4 4v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v4h4" />
        <path d="M9 13h6M9 17h6" />
      </svg>
    ),
  },
  {
    href: '/tracker',
    label: 'Tracker',
    hint: 'Outcomes, interview rounds, questions asked',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4 6 2 2 4-4" /><path d="M4 14l2 2 4-4" />
        <path d="M12 6h8M12 16h8" />
      </svg>
    ),
  },
  {
    href: '/retro',
    label: 'Retrospective',
    hint: 'Recurring questions and recurring mistakes',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" />
      </svg>
    ),
  },
  {
    href: '/profile',
    label: 'Profile',
    hint: 'You, your resume, your standing answers',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
      </svg>
    ),
  },
  {
    href: '/answers',
    label: 'Answers',
    hint: 'Everything it has learned to answer for you',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
];

export function Nav() {
  const pathname = usePathname();
  // Shares one poller with whatever else on the page wants these numbers,
  // rather than running a second interval against the same endpoint.
  const { data } = useOverview();
  // Only questions earn a badge; walls and set-asides wait on the Runs page.
  const badges = { runs: data?.needsYou.needsInput ?? 0, discover: data?.counts.leadsNew ?? 0 };

  // Nothing here works signed out - every link bounces straight back to
  // sign-in via AuthGate - so showing it there is just a wall of dead links
  // above the form.
  if (pathname?.startsWith('/signin')) return null;

  return (
    <nav>
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        const badge =
          item.href === '/runs' ? badges.runs : item.href === '/discover' ? badges.discover : 0;
        return (
          <a
            key={item.href}
            href={item.href}
            title={item.hint}
            aria-current={active ? 'page' : undefined}
            className={active ? 'active' : undefined}
          >
            {item.icon}
            {item.label}
            {badge > 0 && <span className="nav-badge">{badge}</span>}
          </a>
        );
      })}
    </nav>
  );
}
