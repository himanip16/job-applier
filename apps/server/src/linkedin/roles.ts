import type { ContactRole } from '../lib/db.js';

/**
 * Deciding, from a headline, whether someone is worth writing to.
 *
 * A deterministic classifier rather than a model call, for three reasons: it
 * runs once per search result and there are dozens per company, a wrong answer
 * here is visible and correctable in the UI rather than buried in a prompt,
 * and the interesting cases are all near-misses that a rule states better than
 * a paragraph of instructions does.
 *
 * The near-misses are the whole job. "Lead Software Engineer" is an individual
 * contributor and "Engineering Lead" is not. "Technical Recruiter" contains an
 * engineering word and is talent. "Technical Program Manager" contains both an
 * engineering word and a manager word and is neither. Every one of those is a
 * real headline that the obvious two-list implementation gets wrong.
 */

export interface RoleVerdict {
  role: ContactRole;
  /** The phrase that decided it, shown in the UI so a wrong call is debuggable. */
  reason: string;
}

/**
 * The title, separated from the rest of the headline.
 *
 * LinkedIn headlines are free text but overwhelmingly follow "<title> at
 * <company> | <editorial>". The editorial half is where "we're hiring
 * engineers!" and "ex-Google" live, and reading role words out of it is how a
 * backend engineer who mentions recruiting gets classified as a recruiter.
 */
export function titleFrom(headline: string): string {
  const firstSegment = headline.split(/[|•·—–]/)[0] ?? '';
  // " at " and " @ " end the title. Anchored on whitespace so "Data at Scale"
  // splits but "Chat Engineer" does not.
  const beforeCompany = firstSegment.split(/\s+(?:at|@)\s+/i)[0] ?? '';
  return beforeCompany.replace(/\s+/g, ' ').trim();
}

/**
 * Talent words. Checked before anything engineering, because a technical
 * recruiter is a recruiter and the word "technical" must not outvote that.
 */
const TALENT =
  /\b(recruit(?:er|ers|ing|ment)|talent acquisition|talent partner|talent sourcer|talent lead|head of talent|sourcer|staffing|people operations|people ops|hr business partner|hiring team)\b/i;

/**
 * Titles that contain a manager word and an engineering word and are still not
 * an engineering manager. Checked before the pairing rule, not after.
 */
const NOT_ENGINEERING_LEADERSHIP =
  /\b(product manager|product management|product owner|program manager|program management|project manager|project management|account manager|partner manager|community manager|office manager|delivery manager|scrum master|sales|marketing|customer success|business development)\b/i;

/** Titles that are engineering leadership on their own, with no pairing needed. */
const ENGINEERING_LEADERSHIP =
  /\b(cto|chief technology officer|chief technical officer|chief architect|head of engineering|head of technology|head of platform|head of infrastructure|vp of engineering|vp engineering|svp engineering)\b/i;

/**
 * "Lead" only means a manager in these exact shapes. "Lead" before the
 * discipline is an individual contributor - Lead Engineer, Lead Data
 * Scientist - and after it is usually not.
 */
const LEAD_AS_MANAGER =
  /\b(engineering lead|eng lead|team lead|tech lead manager|technical lead manager|development lead|dev lead|platform lead)\b/i;

const MANAGER_WORD = /\b(manager|management|head of|director|vp|vice president|svp|evp|chief)\b/i;

const ENGINEERING_WORD =
  /\b(engineering|engineer|engineers|software|technical|technology|platform|infrastructure|backend|back end|frontend|front end|fullstack|full stack|machine learning|data|mobile|ios|android|devops|sre|site reliability|security engineering|quality engineering|architecture)\b/i;

const matched = (re: RegExp, text: string): string | null => re.exec(text)?.[0] ?? null;

/**
 * Classify one headline.
 *
 * The title carries the decision; the full headline is never consulted for
 * role words. That is a deliberate loss of recall - someone whose headline is
 * only "Building the future @ Acme" comes back OTHER - in exchange for not
 * writing to the wrong person, which is the expensive mistake here.
 */
export function classifyRole(headline: string): RoleVerdict {
  const title = titleFrom(headline);
  if (!title) return { role: 'OTHER', reason: 'no title in headline' };

  const talent = matched(TALENT, title);
  if (talent) return { role: 'TALENT', reason: talent.toLowerCase() };

  const excluded = matched(NOT_ENGINEERING_LEADERSHIP, title);
  if (excluded) return { role: 'OTHER', reason: `${excluded.toLowerCase()} is not engineering leadership` };

  const leadership = matched(ENGINEERING_LEADERSHIP, title);
  if (leadership) return { role: 'ENGINEERING', reason: leadership.toLowerCase() };

  const lead = matched(LEAD_AS_MANAGER, title);
  if (lead) return { role: 'ENGINEERING', reason: lead.toLowerCase() };

  const manager = matched(MANAGER_WORD, title);
  const discipline = matched(ENGINEERING_WORD, title);
  if (manager && discipline) {
    return { role: 'ENGINEERING', reason: `${manager.toLowerCase()} + ${discipline.toLowerCase()}` };
  }

  if (discipline) return { role: 'OTHER', reason: `${discipline.toLowerCase()}, but no manager word` };
  return { role: 'OTHER', reason: 'no talent or engineering-leadership words' };
}

/** The two roles this feature writes to. OTHER is stored but never messaged. */
export const isOutreachTarget = (role: ContactRole): boolean =>
  role === 'TALENT' || role === 'ENGINEERING';

export const ROLE_LABEL: Record<ContactRole, string> = {
  TALENT: 'Talent / recruiting',
  ENGINEERING: 'Engineering leadership',
  OTHER: 'Not a target',
};
