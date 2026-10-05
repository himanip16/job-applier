import path from 'node:path';
import { prisma, type Prisma } from '../lib/db.js';
import { artifactsDir } from '../lib/config.js';
import { bus } from '../lib/events.js';

/**
 * Recording what a run did, as it does it.
 *
 * Every stage of a run needs the same three things - move the status on, file
 * an artifact, shorten a value for a log line - and nothing here knows
 * anything about applications, wizards or forms. Keeping it separate is what
 * lets the stages below import each other without a cycle.
 */
export async function setStatus(
  applicationId: string,
  status: Prisma.ApplicationUpdateInput['status'],
  message: string,
  data?: unknown,
): Promise<void> {
  await prisma.application.update({
    where: { id: applicationId },
    data: { status, blockedReason: message },
  });
  await bus.emitEvent(applicationId, 'STATUS', message, { status, ...(data ?? {}) });
}
export async function artifact(applicationId: string, kind: string, label: string, relPath: string): Promise<void> {
  if (!relPath) return;
  await prisma.artifact.create({ data: { applicationId, kind, label, path: relPath } });
  bus.emit('artifact', { applicationId, kind, label, path: relPath });
}
export async function writeCoverLetterFile(applicationId: string, text: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = path.join(artifactsDir, applicationId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'cover-letter.txt');
  await writeFile(file, text, 'utf8');
  return file;
}
export function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// --- external control surface, used by the API routes ----------------------