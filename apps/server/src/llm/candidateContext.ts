import type { Profile, ProfileFact } from '../lib/db.js';

/**
 * The single source of truth handed to the model about who the candidate is.
 *
 * Everything the LLM is allowed to say about the candidate must be traceable
 * to this block. It is rendered identically for cover letters and for answer
 * inference so the two can never contradict each other.
 */
export function renderCandidateContext(
  profile: Profile & { facts: ProfileFact[] },
  resumeText: string | null,
): string {
  const lines: string[] = [];
  lines.push('<candidate_profile>');
  lines.push(`name: ${profile.fullName}`);
  lines.push(`email: ${profile.email}`);
  if (profile.phone) lines.push(`phone: ${profile.phone}`);
  const loc = [profile.city, profile.region, profile.country].filter(Boolean).join(', ');
  if (loc) lines.push(`location: ${loc}`);
  if (profile.linkedin) lines.push(`linkedin: ${profile.linkedin}`);
  if (profile.github) lines.push(`github: ${profile.github}`);
  if (profile.website) lines.push(`website: ${profile.website}`);
  if (profile.currentCTC) lines.push(`currentCTC: ${profile.currentCTC}`);
  if (profile.expectedCTC) lines.push(`expectedCTC: ${profile.expectedCTC}`);
  if (profile.summary) lines.push(`summary: ${profile.summary}`);
  lines.push('</candidate_profile>');

  if (profile.facts.length) {
    lines.push('');
    lines.push('<known_facts>');
    lines.push('These were stated by the candidate. They are authoritative.');
    for (const f of profile.facts) {
      lines.push(`- [${f.key}] ${f.label}: ${f.value}`);
    }
    lines.push('</known_facts>');
  }

  if (resumeText) {
    lines.push('');
    lines.push('<resume>');
    // Keep it bounded; resumes past ~20k chars are almost always parse noise.
    lines.push(resumeText.slice(0, 20000));
    lines.push('</resume>');
  }
  return lines.join('\n');
}
