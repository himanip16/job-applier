'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * One poller for /api/overview, however many components want it.
 *
 * The nav bar wants the badge counts and the home page wants the same numbers
 * larger, so both used to run their own interval against the same endpoint —
 * two requests every few seconds, out of step with each other, for identical
 * data. Opening devtools on the home page showed a wall of `overview` calls.
 *
 * This keeps a single timer and a single in-flight request at module scope and
 * fans the result out to subscribers. The timer only runs while something is
 * subscribed, so a page that does not need it costs nothing.
 */

export interface Overview {
  setup: { id: string; label: string; done: boolean; detail: string; href: string | null }[];
  ready: boolean;
  needsYou: { needsInput: number; inReview: number; needsHuman: number; total: number };
  counts: {
    leadsNew: number;
    leadsTotal: number;
    strongMatches: number;
    shortlisted: number;
    submitted: number;
    upcomingRounds: number;
    lessons: number;
    answerBank: number;
    companies: number;
  };
}

type Listener = (state: { data: Overview | null; error: string | null }) => void;

const listeners = new Set<Listener>();
let latest: { data: Overview | null; error: string | null } = { data: null, error: null };
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

/** Ten seconds. The numbers here change when a human does something, not on their own. */
const INTERVAL_MS = 10_000;

function publish(next: { data: Overview | null; error: string | null }) {
  latest = next;
  for (const l of listeners) l(next);
}

function refresh(): Promise<void> {
  // Never two at once: a slow response must not stack up behind itself.
  inFlight ??= api<Overview>('/api/overview')
    .then((data) => publish({ data, error: null }))
    .catch((e: unknown) => publish({ data: latest.data, error: (e as Error).message }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useOverview(): { data: Overview | null; error: string | null; refresh: () => void } {
  const [state, setState] = useState(latest);

  useEffect(() => {
    listeners.add(setState);
    // A component mounting mid-cycle should not wait out the interval for its
    // first numbers, but it also should not trigger a fetch when one just
    // landed — the cached value covers that.
    if (!latest.data) void refresh();
    else setState(latest);

    timer ??= setInterval(() => void refresh(), INTERVAL_MS);

    return () => {
      listeners.delete(setState);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return { ...state, refresh: () => void refresh() };
}
