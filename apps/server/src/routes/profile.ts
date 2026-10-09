import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { currentUser } from '../auth/sessions.js';
import type { RequireProfile } from './types.js';
import { contactDetailsFrom } from '../resume/contactDetails.js';

const ProfileInput = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().trim().default(''),
  phone: z.string().trim().optional(),
  city: z.string().trim().optional(),
  region: z.string().trim().optional(),
  country: z.string().trim().optional(),
  countryCode: z.string().trim().optional(),
  citizenship: z.string().trim().optional(),
  expectedCTC: z.string().trim().optional(),
  linkedin: z.string().url().optional(),
  github: z.string().url().optional(),
  website: z.string().url().optional(),
  portfolio: z.string().url().optional(),
  summary: z.string().trim().optional(),
}).transform((data) => ({
  ...data,
  phone: data.phone || undefined,
  city: data.city || undefined,
  region: data.region || undefined,
  country: data.country || undefined,
  countryCode: data.countryCode || undefined,
  citizenship: data.citizenship || undefined,
  expectedCTC: data.expectedCTC || undefined,
  linkedin: data.linkedin || undefined,
  github: data.github || undefined,
  website: data.website || undefined,
  portfolio: data.portfolio || undefined,
  summary: data.summary || undefined,
}));

export function registerProfileRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/profile', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to use this.', code: 'AUTH_REQUIRED' });
    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
      include: { facts: { orderBy: { key: 'asc' } }, resumes: { orderBy: { createdAt: 'desc' } } },
    });
    return { profile };
  });

  /** What the resume says about who you are, for the form to offer. Suggests only; saves nothing. */
  app.get('/api/profile/autofill', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to use this.' });
    const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
    if (!profile?.resumeText) return { details: {}, reason: 'Upload a resume first.' };
    return { details: contactDetailsFrom(profile.resumeText) };
  });

  app.put('/api/profile', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to use this.', code: 'AUTH_REQUIRED' });
    const parseResult = ProfileInput.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'Invalid input', issues: parseResult.error.issues });
    }
    const body = parseResult.data;

    // Check if a profile with this email already exists
    const existingProfile = await prisma.profile.findUnique({
      where: { email: body.email },
    });

    let profile;
    if (existingProfile) {
      // If the existing profile belongs to this user, update it
      if (existingProfile.userId === user.id) {
        profile = await prisma.profile.update({
          where: { id: existingProfile.id },
          data: body,
        });
      } else if (!existingProfile.userId) {
        // If the existing profile has no userId (orphaned), attach it to this user
        profile = await prisma.profile.update({
          where: { id: existingProfile.id },
          data: { ...body, userId: user.id },
        });
      } else {
        // Email belongs to a different user - this is a conflict
        return reply.code(409).send({ error: 'Email already in use by another account' });
      }
    } else {
      // No existing profile with this email, create new one
      profile = await prisma.profile.upsert({
        where: { userId: user.id },
        update: body,
        create: { ...body, userId: user.id },
      });
    }

    // Sync email to User to prevent divergence
    if (profile.email !== user.email) {
      await prisma.user.update({ where: { id: user.id }, data: { email: profile.email } });
    }
    return { profile };
  });
}
