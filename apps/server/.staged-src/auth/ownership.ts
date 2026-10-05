import { prisma } from '../lib/db.js';

/**
 * "Is this row mine?", for every row a URL can name.
 *
 * Authentication and authorisation are different jobs and the app had only
 * the first. A signed-in stranger who guesses an id must not read someone
 * else's application, interview notes or answers - and every route addressed
 * by id was fetching the row and trusting it.
 *
 * These return the row or null, so a caller reads the same as before and the
 * 404 it already had is the right response. Deliberately 404 and not 403: a
 * 403 confirms the id exists, which is the one thing worth not confirming.
 *
 * The indirect ones walk the relation rather than trusting a denormalised
 * column, because there is no denormalised column to trust: an InterviewRound
 * belongs to an Application which belongs to a Profile, and that chain is the
 * only statement of ownership there is.
 */

export async function ownedApplication(profileId: string, id: string) {
  return prisma.application.findFirst({ where: { id, profileId } });
}

export async function ownedLead(profileId: string, id: string) {
  return prisma.jobLead.findFirst({ where: { id, profileId } });
}

export async function ownedRound(profileId: string, id: string) {
  return prisma.interviewRound.findFirst({ where: { id, application: { profileId } } });
}

export async function ownedQuestion(profileId: string, id: string) {
  return prisma.interviewQuestion.findFirst({
    where: { id, round: { application: { profileId } } },
  });
}

export async function ownedLesson(profileId: string, id: string) {
  return prisma.lesson.findFirst({ where: { id, application: { profileId } } });
}

export async function ownedFact(profileId: string, id: string) {
  return prisma.profileFact.findFirst({ where: { id, profileId } });
}

export async function ownedResumeFile(profileId: string, id: string) {
  return prisma.resumeFile.findFirst({ where: { id, profileId } });
}

export async function ownedTailoredResume(profileId: string, id: string) {
  return prisma.tailoredResume.findFirst({ where: { id, profileId } });
}

export async function ownedSignal(profileId: string, id: string) {
  return prisma.preferenceSignal.findFirst({ where: { id, profileId } });
}

/** Not owned by anyone: the watch list is shared, so any signed-in user may edit it. */
export async function existingCompany(id: string) {
  return prisma.company.findUnique({ where: { id } });
}

export const NOT_YOURS = { error: 'Not found' };
