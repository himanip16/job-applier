/**
 * Apply to one job from the terminal, without the UI.
 *
 *   pnpm --filter @ja/server apply -- https://job-boards.greenhouse.io/acme/jobs/123
 *
 * Questions the resolver cannot answer are asked on stdin, and the answers go
 * into the same answer bank the UI writes to.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { adapterFor } from '../ats/registry.js';
import { runApplication, submitAnswers, decideReview } from '../engine/runner.js';
import { rememberAnswer } from '../engine/answerBank.js';
import { closeContext } from '../browser/session.js';

const url = process.argv[2];
if (!url) {
  process.stderr.write('Usage: apply <job-url>\n');
  process.exit(1);
}

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

bus.on(`app:${application.id}`, async (evt: { type: string; data?: unknown }) => {
  if (evt.type === 'QUESTION_ASKED') {
    const pending = await prisma.pendingQuestion.findMany({
      where: { applicationId: application.id, answeredAt: null },
    });
    const replies = [];
    for (const q of pending) {
      stdout.write(`\n${'-'.repeat(60)}\n${q.rawLabel}${q.required ? ' (required)' : ''}\n`);
      if (q.suggestionRationale) stdout.write(`why we are asking: ${q.suggestionRationale}\n`);
      const options = q.options as { label: string }[] | null;
      if (options?.length) {
        options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}\n`));
      }
      if (q.suggestion) stdout.write(`suggested: ${JSON.stringify(q.suggestion)}\n`);

      const raw = (await rl.question('> ')).trim();
      const value =
        options?.length && /^\d+$/.test(raw)
          ? (options[Number(raw) - 1]?.label ?? raw)
          : raw;

      await prisma.pendingQuestion.update({
        where: { id: q.id },
        data: { answeredAt: new Date(), answerValue: value, remember: true },
      });
      await rememberAnswer({
        profileId: profile.id,
        rawLabel: q.rawLabel,
        value,
        displayValue: value,
        fieldKind: q.fieldKind,
        options: options ?? undefined,
        source: 'USER',
        confidence: 1,
      });
      replies.push({ fieldId: q.fieldId, value, remember: true });
    }
    submitAnswers(application.id, replies);
  }

  if (evt.type === 'STATUS' && (evt.data as { status?: string })?.status === 'REVIEW') {
    const filled = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    const plan = (filled.fieldPlan ?? []) as Array<{ label: string; value: unknown; source: string }>;
    stdout.write(`\n${'='.repeat(60)}\nReady to submit:\n`);
    for (const p of plan) {
      stdout.write(`  ${p.label}: ${JSON.stringify(p.value)}  [${p.source}]\n`);
    }
    const ok = (await rl.question('\nSubmit? (y/N) ')).trim().toLowerCase();
    decideReview(application.id, ok === 'y', ok === 'y' ? undefined : 'declined at the terminal');
  }
});

await runApplication(application.id);
rl.close();
await closeContext();
await prisma.$disconnect();
