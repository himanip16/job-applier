'use client';

import { usePathname } from 'next/navigation';
import { useOverview } from '../lib/overview';

/**
 * Navigation that explains itself.
 *
 * A bare list of seven words tells a first-time user nothing about what this
 * app can do, so each item carries a one-line description on hover and a live
 * count when something there needs attention. The counts are the important
 * half: a badge on "Runs" is how you find out a job application is sitting
 * waiting for an answer.
 */
const ITEMS = [
  { href: '/', label: 'Overview', hint: 'What this does, and what still needs setting up' },
  { href: '/discover', label: 'Find work', hint: 'Search for openings that match you, then triage them' },
  { href: '/runs', label: 'Runs', hint: 'Applications being filled in, live' },
  { href: '/resume', label: 'Resume', hint: 'Tailor your CV for one job, ATS-safe' },
  { href: '/tracker', label: 'Tracker', hint: 'Outcomes, interview rounds, questions asked' },
  { href: '/retro', label: 'Retrospective', hint: 'Recurring questions and recurring mistakes' },
  { href: '/profile', label: 'Profile', hint: 'You, your resume, your standing answers' },
  { href: '/answers', label: 'Answers', hint: 'Everything it has learned to answer for you' },
  { href: '/settings', label: 'Settings', hint: 'API keys, model choice, and what each one turns on' },
] as const;

export function Nav() {
  const pathname = usePathname();
  // Shares one poller with whatever else on the page wants these numbers,
  // rather than running a second interval against the same endpoint.
  const { data } = useOverview();
  const badges = { runs: data?.needsYou.total ?? 0, discover: data?.counts.leadsNew ?? 0 };

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
            {item.label}
            {badge > 0 && <span className="nav-badge">{badge}</span>}
          </a>
        );
      })}
    </nav>
  );
}
