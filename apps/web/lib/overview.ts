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
  needsYou: {
    needsInput: number;
    inReview: number;
    needsHuman: number;
    total: number;
    /** The one to go to, so a nudge can be a single click. */
    first: {
      id: string;
      status: string;
      title: string;
      company: string;
      reason: string | null;
    } | null;
  };
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
    /** Applications currently being driven. Non-zero means the state moves on its own. */
    runsInFlight: number;
    /** Matches still waiting on a decision - the number the front page is about. */
    notApplied: number;
  };
  /** The best few of those, so the front page can show them rather than count them. */
  topMatches: {
    id: string;
    title: string;
    companyName: string;
    location: string | null;
    remote: boolean;
    score: number;
    deepScored: boolean;
    status: string;
    url: string;
  }[];
}

type Listener = (state: { data: Overview | null; error: string | null }) => void;

const listeners = new Set<Listener>();
let latest: { data: Overview | null; error: string | null } = { data: null, error: null };
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/**
 * How often to ask, and when not to bother.
 *
 * These numbers only move on their own while a run is going: a run that
 * reaches a question, finishes, or hits a wall changes them without anyone
 * touching the page. The rest of the time they change *because* of something
 * the person just did, and that path reloads the data itself.
 *
 * So: poll briskly while something is in flight or waiting, slowly otherwise,
 * and not at all while the tab is in the background - which is most of the
 * time, and was previously costing twelve database queries every ten seconds
 * on every open tab regardless.
 */
const BUSY_MS = 8_000;
const IDLE_MS = 60_000;

function nextDelay(): number {
  const c = latest.data;
  if (!c) return BUSY_MS;
  return c.needsYou.total > 0 || c.counts.runsInFlight > 0 ? BUSY_MS : IDLE_MS;
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

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

/**
 * Chained timeouts rather than an interval, so the gap can change between
 * ticks - an interval would keep whatever period it was created with.
 */
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!hidden()) await refresh();
    if (listeners.size) schedule();
  }, nextDelay());
}

function onVisibilityChange(): void {
  if (!listeners.size) return;
  // Coming back to the tab should show current numbers straight away, not
  // whatever was true when you left.
  if (!hidden()) void refresh();
  schedule();
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

    if (!timer) {
      schedule();
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      listeners.delete(setState);
      if (listeners.size === 0 && timer) {
        clearTimeout(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, []);

  return { ...state, refresh: () => void refresh() };
}
