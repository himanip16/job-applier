import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/db.js';
import { resumesDir } from '../lib/config.js';
import { extractResumeText, assessResumeText } from '../lib/resumeText.js';

export interface ResumeUploadResult {
  resume: {
    id: string;
    profileId: string;
    label: string;
    filename: string;
    mimeType: string;
    path: string;
    bytes: number;
    isDefault: boolean;
    text: string | null;
    createdAt: Date;
  };
  words: number;
  warning?: string;
}

export async function uploadResume(
  profileId: string,
  file: { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> },
  label?: string
): Promise<ResumeUploadResult> {
  const buf = await file.toBuffer();
  const ext = path.extname(file.filename) || '.pdf';
  const secureName = `${randomBytes(16).toString('hex')}${ext}`;
  const dest = path.join(resumesDir, secureName);
  await writeFile(dest, buf);

  let text = '';
  let warning: string | undefined;
  try {
    text = await extractResumeText(dest, file.mimetype);
    warning = assessResumeText(text).warning;
  } catch (err) {
    warning = (err as Error).message;
  }

  const record = await prisma.$transaction(async (tx) => {
    const existingCount = await tx.resumeFile.count({ where: { profileId } });
    const isFirst = existingCount === 0;
    const record = await tx.resumeFile.create({
      data: {
        profileId,
        label: label ?? 'Default',
        filename: file.filename,
        mimeType: file.mimetype,
        path: dest,
        bytes: buf.length,
        isDefault: isFirst,
        text,
      },
    });

    if (isFirst) {
      await tx.profile.update({ where: { id: profileId }, data: { resumeText: text } });
    }

    return record;
  });

  return {
    resume: record,
    words: text.split(/\s+/).filter(Boolean).length,
    warning,
  };
}

export async function setDefaultResume(profileId: string, resumeId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const resume = await tx.resumeFile.findFirstOrThrow({
      where: { id: resumeId, profileId },
    });

    await tx.resumeFile.updateMany({
      where: { profileId },
      data: { isDefault: false },
    });

    await tx.resumeFile.update({
      where: { id: resume.id },
      data: { isDefault: true },
    });

    await tx.profile.update({
      where: { id: profileId },
      data: { resumeText: resume.text },
    });
  });
}
