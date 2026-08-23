/**
 * Apply to one job from the terminal, without the UI.
 *
 *   pnpm --filter @ja/server apply -- https://job-boards.greenhouse.io/acme/jobs/123
 *
 * Questions the resolver cannot answer are asked on stdin, and the answers go
 * into the same answer bank the UI writes to - under the same identity rules,
 * which is fiddlier than it looks and was previously got wrong here.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { matchCanonical, normalizeLabel } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { adapterFor } from '../ats/registry.js';
import { canonicalUrl } from '../discovery/findJobs.js';
import { runApplication, submitAnswers, decideReview } from '../engine/runner.js';
import { rememberAnswer } from '../engine/answerBank.js';
import { closeContext } from '../browser/session.js';

const raw = process.argv[2];
if (!raw) {
  process.stderr.write('Usage: apply <job-url>\n');
  process.exit(1);
}

// One posting, one row. `/jobs/123`, `/jobs/123/` and `/jobs/123?utm_source=x`
// are the same job, and upserting on the raw string makes three of them - each
// with its own application, its own answers and its own history.
const url = canonicalUrl(raw);

const profile = await prisma.profile.findFirst();
if (!profile) {
  process.stderr.write('No profile yet. Run the seed script first.\n');
  process.exit(1);
}

const adapter = adapterFor(url);
const job = await prisma.job.upsert({
  where: { url },
  create: { url, ats: adapter.id, company: 'pending', title: 'pending' },
  update: {},
});
const application = await prisma.application.upsert({
  where: { profileId_jobId: { profileId: profile.id, jobId: job.id } },
  create: { profileId: profile.id, jobId: job.id },
  update: { status: 'QUEUED', blockedReason: null },
});

const rl = readline.createInterface({ input: stdin, output: stdout });

/**
 * Handle events one at a time, and never leave the run parked.
 *
 * Two hazards, both of which end with the terminal sitting there doing
 * nothing. Events are dispatched without being awaited, so two handlers could
 * in principle interleave and both prompt at once; chaining them makes the
 * ordering explicit rather than relying on the runner happening to park
 * between emissions. And if a handler throws - a bad read on stdin, a database
 * hiccup - the run is left waiting on a reply that will never come, so every
 * failure path still answers.
 */
let queue: Promise<void> = Promise.resolve();
const serialise = (work: () => Promise<void>, onFailure: () => void) => {
  queue = queue
    .then(work)
    .catch((err: unknown) => {
      process.stderr.write(`\nCould not handle that: ${(err as Error).message}\n`);
      onFailure();
    });
};

bus.on(`app:${application.id}`, (evt: { type: string; data?: unknown }) => {
  if (evt.type === 'QUESTION_ASKED') {
    serialise(answerPending, () => submitAnswers(application.id, []));
  }
  if (evt.type === 'STATUS' && (evt.data as { status?: string })?.status === 'REVIEW') {
    serialise(confirmSubmit, () =>
      decideReview(application.id, false, 'the terminal could not read your answer'),
    );
  }
});

async function answerPending(): Promise<void> {
  const pending = await prisma.pendingQuestion.findMany({
    where: { applicationId: application.id, answeredAt: null },
  });
  const withJob = await prisma.application.findUniqueOrThrow({
    where: { id: application.id },
    include: { job: true },
  });

  const replies: Array<{ fieldId: string; value: string; remember: boolean }> = [];
  for (const q of pending) {
    stdout.write(`\n${'-'.repeat(60)}\n${q.rawLabel}${q.required ? ' (required)' : ''}\n`);
    if (q.suggestionRationale) stdout.write(`why we are asking: ${q.suggestionRationale}\n`);
    const options = q.options as { label: string }[] | null;
    if (options?.length) options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}\n`));
    if (q.suggestion) stdout.write(`suggested: ${JSON.stringify(q.suggestion)}\n`);

    const value = await readAnswer(options);

    // Per-company questions must not be recycled. "Why do you want to work at
    // Acme?" banked globally is offered at the next company, which is the one
    // thing the perCompany flag exists to prevent - and the identity has to
    // match what the runner writes after a confirmed submit, or the same
    // answer lands twice.
    const canonical = matchCanonical(q.rawLabel);
    const remember = canonical?.perCompany
      ? true
      : await confirm(`Remember "${truncate(value)}" for future applications? (Y/n) `, true);

    await prisma.pendingQuestion.update({
      where: { id: q.id },
      data: { answeredAt: new Date(), answerValue: value, remember },
    });
    if (remember) {
      await rememberAnswer({
        profileId: profile!.id,
        canonicalKey: canonical?.key,
        rawLabel: q.rawLabel,
        value,
        displayValue: value,
        fieldKind: q.fieldKind,
        options: options ?? undefined,
        source: 'USER',
        confidence: 1,
        scope: canonical?.perCompany ? 'PER_COMPANY' : 'GLOBAL',
        companyKey: normalizeLabel(withJob.job.company),
      });
    }
    replies.push({ fieldId: q.fieldId, value, remember });
  }
  submitAnswers(application.id, replies);
}

/**
 * Read one answer, refusing a choice that is not on offer.
 *
 * Typing 99 against four options used to submit the literal string "99" - and
 * then bank it with confidence 1, so every later application inherited it.
 * A number is either a valid choice or a mistake worth catching here.
 */
async function readAnswer(options: { label: string }[] | null): Promise<string> {
  for (;;) {
    const answer = (await rl.question('> ')).trim();
    if (!options?.length || !/^\d+$/.test(answer)) return answer;

    const picked = options[Number(answer) - 1];
    if (picked) return picked.label;
    stdout.write(`There is no option ${answer}. Choose 1-${options.length}, or type the answer.\n`);
  }
}

async function confirmSubmit(): Promise<void> {
  const filled = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  const plan = (filled.fieldPlan ?? []) as Array<{
    label: string;
    value: unknown;
    source: string;
    error?: string;
  }>;
  stdout.write(`\n${'='.repeat(60)}\nReady to submit:\n`);
  for (const p of plan) {
    stdout.write(`  ${p.label}: ${JSON.stringify(p.value)}  [${p.source}]`);
    stdout.write(p.error ? `  !! ${p.error}\n` : '\n');
  }
  const ok = await confirm('\nSubmit? (y/N) ', false);
  decideReview(application.id, ok, ok ? undefined : 'declined at the terminal');
}

async function confirm(prompt: string, byDefault: boolean): Promise<boolean> {
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  if (!answer) return byDefault;
  return answer === 'y' || answer === 'yes';
}

const truncate = (s: string, n = 40) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

await runApplication(application.id);
// Let any handler still in flight finish before tearing down the terminal and
// the database connection underneath it.
await queue;
rl.close();
await closeContext();
await prisma.$disconnect();
