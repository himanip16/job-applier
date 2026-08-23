'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useOverview } from '../lib/overview';

/**
 * The nudge.
 *
 * Everything here is asynchronous by design — a run fills in a form for a
 * couple of minutes and then hits the one thing only a person can do. Left to
 * itself that means the run sits parked until you happen to look at the right
 * page, which is the difference between this being useful and being a thing
 * you have to babysit.
 *
 * So: a bar on every page naming the single most urgent item and linking
 * straight to it, plus a desktop notification when something new needs you.
 * The server does the other half — it raises the browser window the action is
 * actually in, and once you have dealt with it the run notices by itself and
 * carries on without you coming back here.
 */
export function NeedsYou() {
  const { data } = useOverview();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notifiedFor = useRef<string | null>(null);

  const first = data?.needsYou.first ?? null;
  const total = data?.needsYou.total ?? 0;

  // Notify on a *new* item, not on every poll. Keyed by id so a second run
  // needing you still gets through while the first is unresolved.
  useEffect(() => {
    if (!first || typeof Notification === 'undefined') return;
    if (notifiedFor.current === first.id) return;
    if (Notification.permission !== 'granted') return;

    notifiedFor.current = first.id;
    const n = new Notification(describe(first.status), {
      body: `${first.title} — ${first.company}\n${first.reason ?? 'Open it to see what it needs.'}`,
      tag: first.id,
    });
    n.onclick = () => {
      window.focus();
      window.location.href = `/applications/${first.id}`;
    };
  }, [first]);

  if (!first || total === 0) return null;
  if (dismissed === first.id) return null;
  // Already looking at it.
  if (pathname === `/applications/${first.id}`) return null;

  return (
    <div
      role="status"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        background: 'var(--warn)',
        color: '#111',
        padding: '.5rem .9rem',
      }}
    >
      <div
        className="inner spread"
        style={{ maxWidth: '64rem', margin: '0 auto', gap: '.8rem', alignItems: 'center' }}
      >
        <div style={{ minWidth: 0 }}>
          <strong>{describe(first.status)}</strong>{' '}
          <span style={{ opacity: 0.85 }}>
            {first.title} — {first.company}
            {total > 1 && ` · and ${total - 1} more`}
          </span>
        </div>
        <div className="row" style={{ gap: '.4rem', flex: 'none' }}>
          <NotifyOptIn />
          <a href={`/applications/${first.id}`}>
            <button className="primary">Take the action</button>
          </a>
          <button onClick={() => setDismissed(first.id)} title="Hide until the next one">
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

function describe(status: string): string {
  switch (status) {
    case 'NEEDS_INPUT':
      return 'A question needs answering';
    case 'NEEDS_HUMAN':
      return 'Waiting for you in the browser';
    case 'REVIEW':
      return 'Filled and ready for your approval';
    default:
      return 'Needs you';
  }
}

/**
 * Desktop notifications are opt-in and the browser will only ask from a real
 * click, so this is a button rather than something that happens on load.
 */
function NotifyOptIn() {
  const [state, setState] = useState<NotificationPermission | 'unsupported'>('default');

  useEffect(() => {
    setState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  if (state !== 'default') return null;
  return (
    <button
      onClick={async () => setState(await Notification.requestPermission())}
      title="Get told when a run needs you, even when this tab is in the background"
    >
      Notify me
    </button>
  );
}
