import { cp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../lib/db.js';

/**
 * Put staged server fixes live, but never in the middle of a run.
 *
 * The API runs under `tsx watch`, so saving any file it imports restarts it,
 * and a restart closes the browser page of every application in flight
 * (including ones parked on you). Fixes made while runs are going are written
 * to `apps/server/.staged-src/`, mirroring `src/`, and this copies them over
 * in one go - one restart - once nothing is running.
 *
 *   pnpm --filter @ja/server exec tsx src/scripts/applyStaged.ts           apply if idle, else refuse
 *   pnpm --filter @ja/server exec tsx src/scripts/applyStaged.ts --check   only report live runs
 *   pnpm --filter @ja/server exec tsx src/scripts/applyStaged.ts --wait    poll until idle, then apply
 *
 * Exit code 1 means runs are live and nothing was copied.
 */

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stagedDir = path.join(serverDir, '.staged-src');
const srcDir = path.join(serverDir, 'src');
const POLL_MS = 30_000;

/**
 * Runs a restart would kill. The server fails or requeues orphaned rows on
 * boot (recoverInterruptedRuns), so a live status here is a live run - except
 * the two kinds that outlive a restart on purpose: autopilot questions set
 * aside (no page held), and a possible mid-submit left for a person to check.
 */
async function liveRuns() {
  const rows = await prisma.application.findMany({
    where: {
      status: { in: ['QUEUED', 'PREPARING', 'FILLING', 'NEEDS_INPUT', 'NEEDS_HUMAN', 'REVIEW', 'SUBMITTING'] },
    },
    select: { id: true, status: true, requiresReview: true, blockedReason: true, updatedAt: true },
  });
  return rows.filter((r) => {
    if (r.status === 'NEEDS_INPUT' && !r.requiresReview) return false;
    if (r.status === 'NEEDS_HUMAN' && /Submit was pressed|mid-submit|may have gone through/i.test(r.blockedReason ?? '')) {
      return false;
    }
    return true;
  });
}

async function stagedFiles(dir = stagedDir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await stagedFiles(full)));
    else out.push(full);
  }
  return out;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  for (;;) {
    const live = await liveRuns();
    if (!live.length) break;
    const counts = Object.entries(
      live.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
    )
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');
    if (!args.has('--wait')) {
      console.log(`Not applying: ${live.length} run(s) live (${counts}). Saving into src/ now would restart the server and kill them.`);
      return 1;
    }
    console.log(`${new Date().toLocaleTimeString()}  waiting: ${live.length} run(s) live (${counts})`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (args.has('--check')) {
    console.log('No runs live. Safe to apply.');
    return 0;
  }

  const files = await stagedFiles();
  if (!files.length) {
    console.log('Nothing staged in apps/server/.staged-src.');
    return 0;
  }
  for (const file of files) {
    const rel = path.relative(stagedDir, file);
    const dest = path.join(srcDir, rel);
    if (!(await stat(path.dirname(dest)).catch(() => null))) console.log(`  (new folder) ${path.dirname(rel)}`);
    await cp(file, dest, { recursive: false });
    console.log(`  src/${rel}`);
  }
  await rm(stagedDir, { recursive: true, force: true });
  console.log(`Applied ${files.length} staged file(s). The server restarts once with all of them.`);
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => {});
    process.exit(2);
  });
