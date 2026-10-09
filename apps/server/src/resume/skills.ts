/**
 * The skills a resume lists, read off its SKILLS section.
 *
 * Deliberately not the model: a "Type to Add Skills" box on Workday submits
 * whatever goes in it under the candidate's name, so only skills the resume
 * actually states are offered. A resume without a recognisable skills section
 * yields nothing, and the field falls through to the usual path.
 */

const SKILLS_HEADING = /^(technical\s+|core\s+|key\s+)?(skills|skill\s*set|competencies|technologies|tech\s+stack)(\s*(&|and)\s*\w+)?\s*:?\s*$/i;

/** Any other heading closes the section. */
const OTHER_HEADING =
  /^(summary|profile|objective|(work |professional )?experience|employment|education|projects?|certifications?|publications|awards|achievements|languages|volunteer\w*|interests|hobbies|references)\s*:?\s*$/i;

/** "Languages: Java, Python" - the label is a category, not a skill. */
const CATEGORY_PREFIX = /^[^:]{1,40}:\s*/;

export function skillsFromResume(text: string | null | undefined, limit = 25): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => SKILLS_HEADING.test(l));
  if (start < 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (!line) continue;
    if (OTHER_HEADING.test(line)) break;
    const body = line.replace(/^[-•*·▪●◦]\s*/, '').replace(CATEGORY_PREFIX, '');
    for (const part of splitList(body)) {
      const skill = part.replace(/\.$/, '').trim();
      // Sentences are prose that wandered into the section, not skills.
      if (!skill || skill.length > 40 || skill.split(/\s+/).length > 4) continue;
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(skill);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Split on list separators, but not inside brackets: "AWS (EC2, S3)" is one skill. */
function splitList(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '(' || ch === '[') depth++;
    if ((ch === ')' || ch === ']') && depth > 0) depth--;
    const sep = /[,;|•·▪●\t]/.test(ch) || (ch === '/' && line[i - 1] === ' ' && line[i + 1] === ' ');
    if (sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}
