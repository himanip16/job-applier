'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

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

interface Overview {
  setup: SetupStep[];
  ready: boolean;
  needsYou: { needsInput: number; inReview: number; needsHuman: number; total: number };
  counts: {
    leadsNew: number;
    submitted: number;
    upcomingRounds: number;
    lessons: number;
    answerBank: number;
    companies: number;
  };
}

interface Health {
  llmConfigured: boolean;
  headless: boolean;
  provider: string;
  writing: string;
  judgement: string;
  estimatedCosts: { perApplication: number; perTailoring: number; perDeepScoredLead: number; free: boolean };
}

export default function Home() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api<Overview>('/api/overview').then(setOv).catch((e) => setError(e.message));
      api<Health>('/api/health').then(setHealth).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return (
      <div className="panel">
        <h2>Cannot reach the server</h2>
        <div className="notice bad">{error}</div>
        <p className="small muted" style={{ marginTop: '.6rem' }}>
          Start it with <code>pnpm dev:server</code>. It listens on :8787.
        </p>
      </div>
    );
  }

  const outstanding = ov?.needsYou.total ?? 0;

  return (
    <>
      {outstanding > 0 && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <div className="spread">
            <div>
              <h2>
                {outstanding} thing{outstanding === 1 ? '' : 's'} waiting on you
              </h2>
              <p className="sub" style={{ margin: 0 }}>
                {[
                  ov!.needsYou.needsInput && `${ov!.needsYou.needsInput} run(s) asking a question`,
                  ov!.needsYou.inReview && `${ov!.needsYou.inReview} filled and awaiting approval`,
                  ov!.needsYou.needsHuman && `${ov!.needsYou.needsHuman} blocked on a captcha or login`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <a href="/runs">
              <button className="primary">Go to runs</button>
            </a>
          </div>
        </div>
      )}

      {ov && !ov.ready && <SetupPanel setup={ov.setup} />}

      <div className="panel">
        <h2>What this does</h2>
        <p className="sub">
          Four parts. They work independently — you can paste a single job URL and skip the rest, or
          run the whole loop.
        </p>

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

      <div className="panel">
        <h2>Also here</h2>
        <div className="grid2">
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

      {health && <StatusPanel health={health} submitted={ov?.counts.submitted ?? 0} />}
    </>
  );
}

function SetupPanel({ setup }: { setup: SetupStep[] }) {
  const remaining = setup.filter((s) => !s.done).length;
  return (
    <div className="panel" style={{ borderColor: 'var(--accent)' }}>
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
            <a href={s.href}>
              <button>Fix</button>
            </a>
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
      <a href={href} style={{ flex: 'none' }}>
        <button>{cta}</button>
      </a>
    </div>
  );
}

function Small({ href, title, note }: { href: string; title: string; note: string }) {
  return (
    <a href={href} style={{ textDecoration: 'none', display: 'block', padding: '.6rem 0' }}>
      <strong>{title}</strong>
      <div className="muted small">{note}</div>
    </a>
  );
}

function StatusPanel({ health, submitted }: { health: Health; submitted: number }) {
  const c = health.estimatedCosts;
  return (
    <div className="panel">
      <h2>Status</h2>
      <div className="row" style={{ gap: '2rem', marginTop: '.4rem', alignItems: 'flex-start' }}>
        <Stat label="applications submitted" value={submitted} />
        <Stat
          label="model"
          value={health.provider}
          note={
            health.writing === health.judgement
              ? health.writing
              : `${health.writing} · ${health.judgement}`
          }
        />
        <Stat
          label={c.free ? 'cost' : 'per application'}
          value={c.free ? 'free tier' : `$${c.perApplication.toFixed(3)}`}
          note={c.free ? 'limited by requests, not spend' : `$${c.perTailoring.toFixed(2)} per resume tailor`}
        />
        <Stat
          label="browser"
          value={health.headless ? 'headless' : 'visible'}
          note={health.headless ? 'set HEADLESS=false so you can take over on a captcha' : 'you can take over when needed'}
        />
      </div>
      {!health.llmConfigured && (
        <div className="notice bad" style={{ marginTop: '.9rem' }}>
          No model key configured. Set <code>GEMINI_API_KEY</code> (free at aistudio.google.com/apikey)
          or <code>ANTHROPIC_API_KEY</code> in <code>.env</code> and restart the server. Form filling
          from your profile still works without one; cover letters and inference do not.
        </div>
      )}
      {health.headless && (
        <div className="notice" style={{ marginTop: '.9rem' }}>
          Running headless. Set <code>HEADLESS=false</code> — a visible, persistent browser profile
          passes invisible CAPTCHA far more often, and it is the only way you can take over when a
          challenge appears.
        </div>
      )}
    </div>
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
