'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';

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
  { href: '/discover', label: 'Find work', hint: 'Crawl job boards and triage scored leads' },
  { href: '/runs', label: 'Runs', hint: 'Applications being filled in, live' },
  { href: '/resume', label: 'Resume', hint: 'Tailor your CV for one job, ATS-safe' },
  { href: '/tracker', label: 'Tracker', hint: 'Outcomes, interview rounds, questions asked' },
  { href: '/retro', label: 'Retrospective', hint: 'Recurring questions and recurring mistakes' },
  { href: '/profile', label: 'Profile', hint: 'You, your resume, your standing answers' },
  { href: '/answers', label: 'Answers', hint: 'Everything it has learned to answer for you' },
] as const;

export function Nav() {
  const pathname = usePathname();
  const [badges, setBadges] = useState<{ runs: number; discover: number }>({ runs: 0, discover: 0 });

  useEffect(() => {
    const load = () =>
      api<{ needsYou: { total: number }; counts: { leadsNew: number } }>('/api/overview')
        .then((d) => setBadges({ runs: d.needsYou.total, discover: d.counts.leadsNew }))
        .catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

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
