import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { NOT_YOURS, ownedResumeFile } from '../auth/ownership.js';
import { uploadResume, setDefaultResume } from '../services/resumeService.js';
import { currentUser } from '../auth/sessions.js';
import { prisma } from '../lib/db.js';
import { contactDetailsFrom, type ContactDetails } from '../resume/contactDetails.js';
import type { RequireProfile } from './types.js';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);

const MAX_LABEL_LENGTH = 100;

export function registerResumeUploadRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.post('/api/resume', {
    // A resume is the natural first step, so it may arrive before any
    // profile exists: make one from the account, then fill it from the file.
    preHandler: async (req, reply) => {
      const user = await currentUser(req);
      if (!user) return reply.code(401).send({ error: 'Sign in to use this.' });
      const profile =
        (await prisma.profile.findUnique({ where: { userId: user.id } })) ??
        (await prisma.profile.create({
          data: { userId: user.id, email: user.email, fullName: '', firstName: '', lastName: '' },
        }));
      (req as any).profile = profile;
    }
  }, async (req, reply) => {
    const profile = (req as any).profile;

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'No file uploaded.' });

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return reply.code(400).send({ error: 'Invalid file type. Only PDF, DOC, and DOCX are allowed.' });
    }

    // Validate file extension
    const ext = path.extname(file.filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return reply.code(400).send({ error: 'Invalid file extension. Only .pdf, .doc, and .docx are allowed.' });
    }

    // Validate label length
    const label = (file.fields.label as { value?: string } | undefined)?.value;
    if (label && label.length > MAX_LABEL_LENGTH) {
      return reply.code(400).send({ error: `Label must be ${MAX_LABEL_LENGTH} characters or less.` });
    }

    try {
      const result = await uploadResume(profile.id, file, label);
      const filled = await fillBlanksFromResume(profile.id);
      return { resume: { ...result.resume, text: undefined }, words: result.words, warning: result.warning, filled };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload resume';
      return reply.code(500).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/resume/:id/default', {
    preHandler: async (req, reply) => {
      const profile = await requireProfile(req, reply);
      if (!profile) return reply.code(401).send({ error: 'Sign in to use this.' });
      (req as any).profile = profile;
    }
  }, async (req, reply) => {
    const profile = (req as any).profile;
    if (!(await ownedResumeFile(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    await setDefaultResume(profile.id, req.params.id);
    return { ok: true };
  });
}

const FILLABLE: (keyof ContactDetails)[] = [
  'fullName', 'firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'website', 'city', 'region', 'country',
];

/**
 * Put what the resume says into the profile's empty boxes. Never overwrites:
 * anything you typed yourself wins. Returns the boxes it filled.
 */
async function fillBlanksFromResume(profileId: string): Promise<string[]> {
  const profile = await prisma.profile.findUniqueOrThrow({ where: { id: profileId } });
  const found = contactDetailsFrom(profile.resumeText ?? '');
  const data: Partial<Record<keyof ContactDetails, string>> = {};
  for (const key of FILLABLE) {
    const current = (profile as Record<string, unknown>)[key];
    if ((current === null || current === undefined || current === '') && found[key]) data[key] = found[key];
  }
  if (!Object.keys(data).length) return [];
  await prisma.profile.update({ where: { id: profileId }, data }).catch(() => {});
  return Object.keys(data);
}
