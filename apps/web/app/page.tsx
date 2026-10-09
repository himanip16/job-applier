'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useOverview, type Overview } from '../lib/overview';

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
  const { data: ov, error } = useOverview();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Health is separate and barely changes — a key being added is the only
  // thing that moves it, and that already forces a reload of this page.
  useEffect(() => {
    api<Health>('/api/health')
      .then(setHealth)
      .catch((err) => {
        setHealthError(err.message || 'Failed to load status');
      });
  }, []);

  if (error) {
    return (
      <div className="panel">
        <h2>Cannot reach the server</h2>
        <div className="notice bad">{error}</div>
        <div className="row" style={{ gap: '.6rem', marginTop: '.6rem' }}>
          <button onClick={() => navigator.clipboard.writeText('pnpm dev:server')}>
            Copy start command
          </button>
          <span className="small muted">Server runs on port 8787</span>
        </div>
      </div>
    );
  }

  const outstanding = ov?.needsYou.needsInput ?? 0;

  return (
    <>
      <Hero ov={ov} />

      <NotAppliedYet ov={ov} />

      {ov && !ov.ready && <SetupPanel setup={ov.setup} />}

      <details className="panel disclosure">
        <summary>
          <strong>How it works</strong>
          <span className="muted small">four parts, each usable on its own</span>
        </summary>
        <div className="disclosure-body">

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
          title="Track and learn"
          href="/tracker"
          cta="Open the tracker"
          badge={ov?.counts.upcomingRounds || undefined}
        >
          Outcomes, interview rounds, the questions you were asked, and what you think you got
          wrong.
          {ov?.counts.upcomingRounds ? ` ${ov.counts.upcomingRounds} round(s) scheduled.` : ''}
        </Feature>
        </div>
      </details>

      <div className="panel">
        <h2>Also here</h2>
        <div className="stats" style={{ marginTop: '.7rem' }}>
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
      <div className="panel-head">
        <div>
          <h2>Matches you have not applied to</h2>
          <p className="sub">{total} saved or new. Best {matches.length} first.</p>
        </div>
        <a href="/discover" className="btn primary">
          See all {total}
        </a>
      </div>

      <div className="list">
        {matches.map((m) => {
          const score = Math.round(m.score);
          const band = score >= 70 ? 'high' : score >= 45 ? 'mid' : 'low';
          return (
            <a key={m.id} href={`/jobs/${m.id}`} className="list-row">
              <span className="list-row-main">
                <span className={`score ${band}`}>{score}</span>
                <span className="list-row-title">{m.title}</span>
                <span className="muted small">{m.companyName}</span>
                {m.remote && <span className="src">remote</span>}
                {m.location && <span className="muted small">{m.location}</span>}
                {m.status === 'SHORTLISTED' && <span className="src">saved</span>}
                {!m.deepScored && (
                  <span className="src" title="Ranked on keywords only, not read in full">
                    quick score
                  </span>
                )}
              </span>
              <span className="btn small">Open</span>
            </a>
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
        applications, and stops to ask you only when it genuinely cannot answer honestly.
      </p>

      {loading ? (
        <div className="stats" style={{ marginTop: '1.1rem' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skel" style={{ height: '4.5rem' }} />
          ))}
        </div>
      ) : nothingYet ? (
        <div className="row" style={{ gap: '.6rem', marginTop: '1rem' }}>
          <a href="/discover" className="btn primary">
            Find jobs for me
          </a>
          <a href="/runs" className="btn">
            Or paste a job URL
          </a>
        </div>
      ) : (
        <div className="stats" style={{ marginTop: '1.1rem' }}>
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
                  y!.needsInput && `${y!.needsInput} run(s) asking a question`,
                  y!.inReview && `${y!.inReview} filled and awaiting your approval`,
                  y!.needsHuman && `${y!.needsHuman} blocked on a captcha or login`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <a href="/runs" className="btn primary">
              Open them
            </a>
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
    <a href={href} className="stat" title={hint}>
      <div className="stat-value" style={{ color: tone ?? 'inherit' }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </a>
  );
}

function SetupPanel({ setup }: { setup: SetupStep[] }) {
  const todo = setup.filter((s) => !s.done);
  const done = setup.filter((s) => s.done);

  /*
   * The unfinished steps are the panel; the finished ones are a receipt.
   *
   * Listing all six at equal weight made a tall blue slab in which the two
   * steps you can actually act on were the hardest to pick out - a checklist
   * that grows more prominent the more of it you complete has it backwards.
   */
  return (
    <div className="panel" style={{ borderColor: 'var(--accent-border)' }}>
      <div className="panel-head">
        <div>
          <h2>Finish setting up</h2>
          <p className="sub">
            {todo.length} step{todo.length === 1 ? '' : 's'} left. Each one removes work later.
          </p>
        </div>
        <span className="muted small nums">
          {done.length}/{setup.length} done
        </span>
      </div>

      <div className="list">
        {todo.map((s) => (
          <div key={s.id} className="list-row">
            <span className="list-row-main" style={{ flexWrap: 'nowrap' }}>
              <span className="setup-dot" aria-hidden="true" />
              <span style={{ minWidth: 0 }}>
                <span className="list-row-title">{s.label}</span>
                <span className="muted small" style={{ display: 'block' }}>
                  {s.detail}
                </span>
              </span>
            </span>
            {s.href && (
              <a href={s.href} className="btn small primary">
                {s.label.startsWith('Upload') ? 'Upload' : 'Fill in'}
              </a>
            )}
          </div>
        ))}
      </div>

      {done.length > 0 && (
        <div className="row setup-done">
          {done.map((s) => (
            <span key={s.id} className="muted small" title={s.detail}>
              <span className="setup-tick" aria-hidden="true">
                ✓
              </span>
              {s.label}
            </span>
          ))}
        </div>
      )}
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
            <a href={href}>
              <strong>{title}</strong>
            </a>
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
      <a href={href} className="btn small">
        {cta}
      </a>
    </div>
  );
}

function Small({ href, title, note }: { href: string; title: string; note: string }) {
  return (
    <a href={href} className="stat">
      <strong>{title}</strong>
      <div className="stat-label">{note}</div>
    </a>
  );
}

function StatusPanel({ health, submitted }: { health: Health; submitted: number }) {
  /*
   * One line, not a panel. "0 applications submitted / operational" was
   * taking a full-width card to say nothing you would act on; it belongs at
   * the bottom of the page in the size of a footnote.
   */
  return (
    <p className="muted small" style={{ textAlign: 'center', marginTop: '1.5rem' }}>
      <span className="nums">{submitted}</span> application{submitted === 1 ? '' : 's'} submitted ·
      server {health.ok ? 'operational' : 'degraded'}
    </p>
  );
}

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div>
      <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>{value}</div>
      <div className="muted small">{label}</div>
      {note && <div className="muted small" style={{ opacity: 0.75 }}>{note}</div>}
    </div>
  );
}
