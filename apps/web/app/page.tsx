'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { useOverview, type Overview } from '../lib/overview';
import { useAuth } from '../lib/auth';

/**
 * The overview.
 *
 * A tool with four largely independent features and a nav bar is a tool where
 * three of the features are never found. So this page does the finding: it
 * says what each part is for in one line, shows what is still unconfigured
 * with a link to fix it, and puts anything currently waiting on a human right
 * at the top — that last number is the only thing worth reacting to
 * immediately.
 */

interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  detail: string;
  href: string | null;
}

interface Health {
  ok: boolean;
}

export default function Home() {
  const auth = useAuth();
  const { data: ov, error } = useOverview(auth.authenticated && !!auth.profile);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Health is separate and barely changes — a key being added is the only
  // thing that moves it, and that already forces a reload of this page.
  useEffect(() => {
    let isMounted = true;
    
    api<Health>('/api/health')
      .then((data) => {
        if (isMounted) {
          setHealth(data);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setHealthError(err.message || 'Failed to load status');
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Show loading state while checking authentication
  if (auth.loading) {
    return (
      <div className="panel">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
            gap: '.75rem',
            marginTop: '1.1rem',
          }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skel" style={{ height: '4.5rem' }} />
          ))}
        </div>
      </div>
    );
  }

  // Show auth error if authentication check failed
  if (auth.error) {
    return (
      <div className="panel">
        <h2>Authentication error</h2>
        <div className="notice bad">{auth.error}</div>
      </div>
    );
  }

  // Show sign-in prompt if not authenticated
  if (!auth.authenticated) {
    return (
      <div className="panel">
        <h2>Sign in required</h2>
        <p className="sub">Please sign in to access your job search dashboard.</p>
        <Link href="/signin" className="primary" style={{
          display: 'inline-block',
          padding: '.4rem .8rem',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--accent)',
          color: 'white',
          textDecoration: 'none',
        }}>
          Sign in
        </Link>
      </div>
    );
  }

  // Show profile creation prompt if authenticated but no profile
  if (!auth.profile) {
    return (
      <div className="panel">
        <h2>Create your profile</h2>
        <p className="sub">Please create your profile to get started with job applications.</p>
        <Link href="/profile" className="primary" style={{
          display: 'inline-block',
          padding: '.4rem .8rem',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--accent)',
          color: 'white',
          textDecoration: 'none',
        }}>
          Create profile
        </Link>
      </div>
    );
  }

  // Show overview error if overview fetch failed
  if (error) {
    let errorMessage = error;
    let errorTitle = 'Cannot reach the server';

    // Try to classify error from message string
    if (error.includes('Failed to fetch') || error.includes('ECONNREFUSED') || error.includes('NetworkError')) {
      errorTitle = 'Cannot reach the server';
      errorMessage = 'The application server is unavailable. Please check your connection and try again.';
    } else if (error.includes('401') || error.includes('AUTH_REQUIRED')) {
      errorTitle = 'Authentication required';
      errorMessage = 'Please sign in to access this page.';
    } else if (error.includes('404') || error.includes('not found')) {
      errorTitle = 'Resource not found';
      errorMessage = 'The requested resource could not be found.';
    } else if (error.includes('500') || error.includes('502') || error.includes('503')) {
      errorTitle = 'Server error';
      errorMessage = 'The server encountered an error. Please try again later.';
    }

    return (
      <div className="panel">
        <h2>{errorTitle}</h2>
        <div className="notice bad">{errorMessage}</div>
        <div className="row" style={{ gap: '.6rem', marginTop: '.6rem' }}>
          <button
            onClick={() => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText('pnpm dev:server').then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }
            }}
            style={{
              display: 'inline-block',
              padding: '.4rem .8rem',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--border)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'inherit',
            }}
            title="For local development"
          >
            {copied ? 'Copied!' : 'Copy dev start command'}
          </button>
          <span className="small muted" style={{ display: 'flex', alignItems: 'center' }}>
            (For local development only)
          </span>
        </div>
      </div>
    );
  }

  const outstanding = ov?.needsYou.total ?? 0;

  return (
    <>
      <Hero ov={ov} />

      <NotAppliedYet ov={ov} />

      {ov && !ov.ready && <SetupPanel setup={ov.setup} />}

      <details className="panel">
        <summary style={{ cursor: 'pointer' }}>
          <strong>How it works</strong>{' '}
          <span className="muted small">
            — four parts, each usable on its own
          </span>
        </summary>

        <Feature
          step="1"
          title="Find work"
          href="/discover"
          cta={
            ov?.counts.leadsNew
              ? `Triage ${ov.counts.leadsNew} lead${ov.counts.leadsNew === 1 ? '' : 's'}`
              : 'Find jobs for me'
          }
          badge={ov?.counts.leadsNew || undefined}
        >
          Searches the web for openings that match your resume — you do not name the companies —
          and keeps only postings on boards it can actually submit to. Reject one and say why, and
          the ranking moves: the similar job further down re-ranks immediately.
          {ov?.counts.companies ? ` ${ov.counts.companies} board(s) found so far.` : ''}
        </Feature>

        <Feature
          step="2"
          title="Apply"
          href="/runs"
          cta="Paste a job URL"
          badge={outstanding || undefined}
        >
          Opens the real form in a real browser, fills what it can from your profile and answer
          bank, writes a cover letter, attaches your resume. When it cannot answer something
          honestly it stops and asks you, then remembers your answer forever.
        </Feature>

        <Feature
          step="3"
          title="Tailor your resume"
          href="/resume"
          cta="Tailor for a job"
        >
          Pulls the keywords a screener looks for and adds only the ones your own material actually
          supports, each with the evidence. Anything it cannot ground is reported as a gap rather
          than quietly written in — which is useful even when you do not send the resume.
        </Feature>

        <Feature
          step="4"
          title="LinkedIn outreach"
          href="/outreach"
          cta="Open outreach queue"
        >
          Sync your LinkedIn connections, generate personalized cold messages, track replies,
          and manage follow-ups — all with AI-generated outreach that stays within character limits.
        </Feature>

        <Feature
          step="5"
          title="Track and learn"
          href="/tracker"
          cta="Open the tracker"
          badge={ov?.counts.upcomingRounds || undefined}
        >
          Outcomes, interview rounds, the questions you were asked, and what you think you got
          wrong.
          {ov?.counts.upcomingRounds ? ` ${ov.counts.upcomingRounds} round(s) scheduled.` : ''}
        </Feature>
      </details>

      <div className="panel">
        <h2>Also here</h2>
        <div className="grid2">
          <Small
            href="/outreach"
            title="LinkedIn outreach"
            note="Sync connections, generate AI messages, track replies and follow-ups"
          />
          <Small
            href="/retro"
            title="Retrospective"
            note={
              ov?.counts.lessons
                ? `${ov.counts.lessons} lesson(s) recorded, plus the questions several companies asked you`
                : 'Recurring interview questions and recurring mistakes, once you have logged a few'
            }
          />
          <Small
            href="/answers"
            title="Answer bank"
            note={
              ov?.counts.answerBank
                ? `${ov.counts.answerBank} answer(s) learned. Editable — they get submitted under your name`
                : 'Fills itself as you answer questions during applications'
            }
          />
          <Small
            href="/profile"
            title="Profile and standing answers"
            note="The more of this you fill in, the fewer popups you see"
          />
        </div>
      </div>

      {healthError ? (
        <div className="panel">
          <h2>Status unavailable</h2>
          <div className="notice bad">{healthError}</div>
        </div>
      ) : health ? (
        <StatusPanel health={health} submitted={ov?.counts.submitted ?? 0} />
      ) : null}
    </>
  );
}


/**
 * The one list worth putting first.
 *
 * The front page used to open on five counters and a "how it works"
 * accordion, which describes the tool rather than the job search. The useful
 * question on opening it is "which companies match me that I have not applied
 * to yet" - so that is the list, by name, with the buttons on it.
 *
 * Everything already applied to is deliberately not here. It is history, and
 * history belongs in the tracker.
 */
function NotAppliedYet({ ov }: { ov: Overview | null }) {
  const matches = ov?.topMatches ?? [];
  if (!ov || matches.length === 0) return null;
  const total = ov.counts.notApplied;

  return (
    <div className="panel">
      <div className="spread">
        <div>
          <h2 style={{ margin: 0 }}>Matches you have not applied to</h2>
          <p className="sub" style={{ margin: '.2rem 0 0' }}>
            {total} saved or new. Best {matches.length} first.
          </p>
        </div>
        <Link href="/discover" className="primary" style={{
          display: 'inline-block',
          padding: '.4rem .8rem',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--accent)',
          color: 'white',
          textDecoration: 'none',
        }}>
          See all {total}
        </Link>
      </div>

      <div style={{ marginTop: '.6rem' }}>
        {matches.map((m) => {
          const score = Math.round(m.score);
          const tone = score >= 70 ? 'var(--good)' : score >= 45 ? 'var(--warn)' : 'var(--bad)';
          return (
            <Link
              key={m.id}
              href={`/jobs/${m.id}`}
              className="spread"
              style={{
                borderTop: '1px solid var(--border)',
                padding: '.6rem .3rem',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                color: 'inherit',
                display: 'flex',
                alignItems: 'center',
                overflow: 'hidden',
              }}
            >
              <div className="row" style={{ gap: '.55rem', minWidth: 0, flex: 1, overflow: 'hidden' }}>
                <span
                  style={{
                    flex: 'none',
                    minWidth: '2.1rem',
                    textAlign: 'center',
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    color: tone,
                    background:
                      score >= 70 ? 'var(--good-soft)' : score >= 45 ? 'var(--warn-soft)' : 'var(--bad-soft)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '.15rem .3rem',
                    fontSize: '.85rem',
                  }}
                >
                  {score}
                </span>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <strong style={{ color: 'var(--text)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</strong>
                  <div className="row" style={{ gap: '.55rem', marginTop: '.1rem', overflow: 'hidden' }}>
                    <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.companyName}</span>
                    {m.remote && <span className="src">remote</span>}
                    {m.location && <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.location}</span>}
                    {m.status === 'SHORTLISTED' && <span className="src">saved</span>}
                    {!m.deepScored && (
                      <span className="src" title="Ranked on keywords only, not read in full">
                        quick score
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <span style={{
                flex: 'none',
                padding: '.3rem .6rem',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--border)',
                fontSize: '.85rem',
              }}>Open</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Hero({ ov }: { ov: Overview | null }) {
  const c = ov?.counts;
  const y = ov?.needsYou;
  const outstanding = y?.total ?? 0;
  const loading = !ov;
  const nothingYet = !loading && (c?.leadsTotal ?? 0) === 0 && (c?.submitted ?? 0) === 0;

  return (
    <div className="panel">
      <h1 style={{ fontSize: '1.9rem', margin: '0 0 .2rem', letterSpacing: '-.02em' }}>
        Your job search, on autopilot.
      </h1>
      <p className="sub" style={{ marginTop: 0, maxWidth: '42rem' }}>
        It finds the openings, ranks them against what you actually want, fills in the
        applications, manages LinkedIn outreach, and stops to ask you only when it genuinely cannot answer honestly.
      </p>

      {loading ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
            gap: '.75rem',
            marginTop: '1.1rem',
          }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skel" style={{ height: '4.5rem' }} />
          ))}
        </div>
      ) : nothingYet ? (
        <div className="row" style={{ gap: '.6rem', marginTop: '1rem' }}>
          <Link href="/discover" className="primary" style={{
            display: 'inline-block',
            padding: '.4rem .8rem',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent)',
            color: 'white',
            textDecoration: 'none',
          }}>
            Find jobs for me
          </Link>
          <Link href="/runs" style={{
            display: 'inline-block',
            padding: '.4rem .8rem',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--border)',
            textDecoration: 'none',
          }}>
            Or paste a job URL
          </Link>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
            gap: '.75rem',
            marginTop: '1.1rem',
          }}
        >
          {/*
            Ordered by what you can do something about. "Not applied yet" is
            first because it is the only number that is a to-do list; the ones
            after it are progress, and "submitted" is history - which is why it
            links away to the tracker rather than living here.
          */}
          <Big
            href="/discover"
            value={c?.notApplied ?? 0}
            label="not applied yet"
            tone={(c?.notApplied ?? 0) > 0 ? 'var(--accent)' : undefined}
          />
          <Big
            href="/discover"
            value={c?.strongMatches ?? 0}
            label="strong matches"
            tone={(c?.strongMatches ?? 0) > 0 ? 'var(--good)' : undefined}
            hint="Scored 70 or higher by the ranking, automatically - not the same as saved or applied to."
          />
          <Big href="/runs" value={y?.inReview ?? 0} label="applications ready" />
          <Big
            href="/runs"
            value={outstanding}
            label="waiting for you"
            tone={outstanding > 0 ? 'var(--warn)' : undefined}
          />
          <Big href="/tracker" value={c?.submitted ?? 0} label="already applied" />
        </div>
      )}

      {outstanding > 0 && (
        <div className="notice" style={{ borderColor: 'var(--warn)', marginTop: '1rem' }}>
          <div className="spread">
            <div>
              <strong>
                {outstanding} thing{outstanding === 1 ? '' : 's'} need{outstanding === 1 ? 's' : ''}{' '}
                you
              </strong>
              <div className="muted small">
                {[
                  y?.needsInput && `${y.needsInput} run(s) asking a question`,
                  y?.inReview && `${y.inReview} filled and awaiting your approval`,
                  y?.needsHuman && `${y.needsHuman} blocked on a captcha or login`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <Link href="/runs" className="primary" style={{
              display: 'inline-block',
              padding: '.4rem .8rem',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--accent)',
              color: 'white',
              textDecoration: 'none',
            }}>
              Open them
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Big({
  href,
  value,
  label,
  tone,
  hint,
}: {
  href: string;
  value: number;
  label: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <Link href={href} className="stat" title={hint} style={{ textDecoration: 'none' }}>
      <div className="stat-value" style={{ color: tone ?? 'inherit' }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </Link>
  );
}

function SetupPanel({ setup }: { setup: SetupStep[] }) {
  const remaining = setup.filter((s) => !s.done).length;
  return (
    <div className="panel" style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' }}>
      <h2>Finish setting up</h2>
      <p className="sub">
        {remaining} step{remaining === 1 ? '' : 's'} left. Each one removes work later.
      </p>
      {setup.map((s) => (
        <div
          key={s.id}
          className="spread"
          style={{ padding: '.45rem 0', borderTop: '1px solid var(--border)' }}
        >
          <div>
            <span style={{ color: s.done ? 'var(--good)' : 'var(--muted)', marginRight: '.5rem' }}>
              {s.done ? '✓' : '○'}
            </span>
            <strong style={{ opacity: s.done ? 0.6 : 1 }}>{s.label}</strong>
            <div className="muted small" style={{ marginLeft: '1.4rem' }}>
              {s.detail}
            </div>
          </div>
          {!s.done && s.href && (
            <Link href={s.href} style={{
              display: 'inline-block',
              padding: '.3rem .6rem',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--border)',
              textDecoration: 'none',
            }}>
              Fix
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

function Feature({
  step,
  title,
  href,
  cta,
  badge,
  children,
}: {
  step: string;
  title: string;
  href: string;
  cta: string;
  badge?: number;
  children: React.ReactNode;
}) {
  const handleLinkClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className="spread"
      style={{ borderTop: '1px solid var(--border)', padding: '.9rem 0', alignItems: 'flex-start' }}
    >
      <div style={{ display: 'flex', gap: '.85rem', minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            flex: 'none',
            width: '1.6rem',
            height: '1.6rem',
            borderRadius: '50%',
            border: '1px solid var(--border)',
            display: 'grid',
            placeItems: 'center',
            fontSize: '.8rem',
            color: 'var(--muted)',
          }}
        >
          {step}
        </span>
        <div>
          <div className="row" style={{ gap: '.5rem' }}>
            <Link href={href} style={{ textDecoration: 'none' }} onClick={handleLinkClick}>
              <strong>{title}</strong>
            </Link>
            {badge ? (
              <span className="pill NEEDS_INPUT" style={{ textTransform: 'none' }}>
                {badge}
              </span>
            ) : null}
          </div>
          <p className="small muted" style={{ margin: '.2rem 0 0', maxWidth: '46rem' }}>
            {children}
          </p>
        </div>
      </div>
      <Link href={href} style={{ flex: 'none',
        display: 'inline-block',
        padding: '.3rem .6rem',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--border)',
        textDecoration: 'none',
      }} onClick={handleLinkClick}>
        {cta}
      </Link>
    </div>
  );
}

function Small({ href, title, note }: { href: string; title: string; note: string }) {
  return (
    <Link href={href} style={{ textDecoration: 'none', display: 'block', padding: '.6rem 0' }}>
      <strong>{title}</strong>
      <div className="muted small">{note}</div>
    </Link>
  );
}

function StatusPanel({ health, submitted }: { health: Health; submitted: number }) {
  return (
    <div className="panel">
      <h2>Status</h2>
      <div className="row" style={{ gap: '2rem', marginTop: '.4rem', alignItems: 'flex-start' }}>
        <Stat label="applications submitted" value={submitted} />
        <Stat 
          label="system" 
          value={health.ok ? 'operational' : 'degraded'} 
          tone={health.ok ? undefined : 'var(--warn)'}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string | number; note?: string; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: '1.25rem', fontWeight: 600, color: tone ?? 'inherit' }}>{value}</div>
      <div className="muted small">{label}</div>
      {note && <div className="muted small" style={{ opacity: 0.75 }}>{note}</div>}
    </div>
  );
}
