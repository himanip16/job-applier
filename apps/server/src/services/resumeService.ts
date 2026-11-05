import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/db.js';
import { resumesDir } from '../lib/config.js';
import { extractResumeText, assessResumeText } from '../lib/resumeText.js';
import { updateProfileKeywords } from '../discovery/keywordExtraction.js';

// Allowed file extensions for security
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt']);
// Maximum file size to prevent DoS (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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

  // Validate file size to prevent DoS
  if (buf.length > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum allowed size of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  // Validate file extension to prevent arbitrary file upload
  const ext = path.extname(file.filename).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Invalid file extension. Allowed extensions: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`);
  }

  const secureName = `${randomBytes(16).toString('hex')}${ext}`;
  const dest = path.join(resumesDir, secureName);

  // Write file to disk first
  await writeFile(dest, buf);

  let text = '';
  let warning: string | undefined;
  let textExtractionSuccess = false;

  try {
    text = await extractResumeText(dest, file.mimetype);
    warning = assessResumeText(text).warning;
    textExtractionSuccess = true;
  } catch (err) {
    warning = (err as Error).message;
    text = '';
  }

  let record;
  try {
    record = await prisma.$transaction(async (tx) => {
      // Check if profile exists
      const profile = await tx.profile.findUnique({
        where: { id: profileId },
        select: { id: true },
      });

      if (!profile) {
        throw new Error('Profile not found');
      }

      // Always create with isDefault: false first to avoid race condition
      const record = await tx.resumeFile.create({
        data: {
          profileId,
          label: label ?? 'Default',
          filename: file.filename,
          mimeType: file.mimetype,
          path: dest,
          bytes: buf.length,
          isDefault: false,
          text,
        },
      });

      // Check if this is the only resume for the profile - if so, make it default
      const totalResumes = await tx.resumeFile.count({ where: { profileId } });
      if (totalResumes === 1) {
        const updatedRecord = await tx.resumeFile.update({
          where: { id: record.id },
          data: { isDefault: true },
        });

        // Only update profile resumeText if text extraction succeeded
        if (textExtractionSuccess && text) {
          await tx.profile.update({ where: { id: profileId }, data: { resumeText: text } });
        }

        return updatedRecord;
      }

      return record;
    });
  } catch (transactionErr) {
    // If database transaction fails, clean up the orphaned file
    try {
      await unlink(dest);
    } catch (unlinkErr) {
      // Log but don't throw - file cleanup is best-effort
      console.error('Failed to cleanup orphaned file after transaction error:', unlinkErr);
    }
    throw transactionErr;
  }

  // Extract and store keywords from the resume (outside transaction to avoid timeout)
  // Pass the expected resume text for concurrency check
  if (textExtractionSuccess && text && text.trim().length >= 100) {
    await updateProfileKeywords(profileId, text);
  }

  return {
    resume: record,
    words: text.split(/\s+/).filter(Boolean).length,
    warning,
  };
}

export async function setDefaultResume(profileId: string, resumeId: string): Promise<void> {
  const resume = await prisma.$transaction(async (tx) => {
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

    // Only update profile resumeText if the resume has valid text
    if (resume.text && resume.text.trim().length > 0) {
      await tx.profile.update({
        where: { id: profileId },
        data: { resumeText: resume.text },
      });
    }

    return resume;
  });

  // Extract and store keywords from the new default resume (outside transaction to avoid timeout)
  // Pass the expected resume text for concurrency check
  if (resume.text && resume.text.trim().length >= 100) {
    await updateProfileKeywords(profileId, resume.text);
  }
}
