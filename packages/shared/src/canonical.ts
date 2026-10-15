/**
 * Canonical question keys + the deterministic rules that map real-world form
 * labels onto them.
 *
 * This layer exists because ~70% of the questions on any application form are
 * the same twenty questions in different words. Recognising them with regex is
 * free, instant and 100% predictable — far better than paying an LLM to
 * re-derive "are you legally authorized to work in the US?" every single time.
 * The LLM only sees what these rules miss.
 */

export interface CanonicalQuestion {
  key: string;
  /** Human-readable prompt used when we have to ask the user. */
  prompt: string;
  kind: 'TEXT' | 'BOOLEAN' | 'NUMBER' | 'ENUM' | 'DATE' | 'LIST';
  /** Patterns that identify this question in the wild. */
  patterns: RegExp[];
  /** Demographic/EEO — always optional, never inferred, never remembered
   *  without an explicit opt-in. */
  sensitive?: boolean;
  /** Answer is company-specific; never reuse across employers. */
  perCompany?: boolean;
}

export const CANONICAL_QUESTIONS: CanonicalQuestion[] = [
  {
    key: 'identity.first_name',
    prompt: 'First name',
    kind: 'TEXT',
    patterns: [/^first\s*name/i, /^given\s*name/i, /^legal\s*first/i],
  },
  {
    key: 'identity.last_name',
    prompt: 'Last name',
    kind: 'TEXT',
    patterns: [/^last\s*name/i, /^family\s*name/i, /^surname/i, /^legal\s*last/i, /^preferred\s*(last|family)\s*name/i],
  },
  {
    key: 'identity.preferred_name',
    prompt: 'Preferred first name',
    kind: 'TEXT',
    patterns: [/preferred\s*(first\s*)?name/i, /nickname/i, /what.*(should|do) we call you/i],
  },
  {
    key: 'identity.full_name',
    prompt: 'Full name',
    kind: 'TEXT',
    patterns: [/^full\s*name/i, /^name$/i, /^your name/i],
  },
  {
    key: 'identity.legal_name_matches_id',
    prompt: 'Does the legal name you give on applications match the name on your government ID?',
    kind: 'BOOLEAN',
    // Walmart (Workday): "Does the Legal Name you provided on the "My
    // Information" page match the name on your legal ID?"
    patterns: [/legal name.*match/i, /name.*(match|same as).*(legal|government|official|photo)\s*id/i],
  },
  {
    key: 'identity.pronouns',
    prompt: 'Pronouns',
    kind: 'TEXT',
    patterns: [/pronoun/i],
    sensitive: true,
  },
  {
    key: 'contact.email',
    prompt: 'Email address',
    kind: 'TEXT',
    patterns: [/e-?mail/i],
  },
  {
    key: 'contact.phone',
    prompt: 'Phone number',
    kind: 'TEXT',
    patterns: [/^phone(?!\s*(ext|extension|type|device))/i, /mobile\s*(number|phone)/i, /telephone(?!\s*ext)/i, /contact number/i],
  },
  {
    key: 'contact.sms_opt_in',
    prompt: 'Do you want recruiting updates by text message (opt in or out)?',
    kind: 'BOOLEAN',
    patterns: [/text message (updates|notifications|alerts)/i, /\bsms (updates|notifications|alerts)/i, /receive (mobile )?text/i],
  },
  {
    key: 'contact.linkedin',
    prompt: 'LinkedIn profile URL',
    kind: 'TEXT',
    patterns: [/linked\s*-?\s*in/i],
  },
  {
    key: 'contact.github',
    prompt: 'GitHub profile URL',
    kind: 'TEXT',
    patterns: [/git\s*-?\s*hub/i],
  },
  {
    key: 'contact.website',
    prompt: 'Personal website / portfolio URL',
    kind: 'TEXT',
    patterns: [/personal\s*(web)?site/i, /portfolio/i, /other\s*website/i, /^website/i, /your\s*url/i],
  },
  {
    // Just the city. A bare "City" box - often a place autocomplete, as on
    // SmartRecruiters - searches badly on "Bangalore, Karnataka, India".
    key: 'location.city',
    prompt: 'City',
    kind: 'TEXT',
    patterns: [/^(city|town)$/i],
  },
  {
    key: 'location.current',
    prompt: 'Where are you currently located? (city, country)',
    kind: 'TEXT',
    patterns: [
      /current\s*(city|location|residence)/i,
      /^location/i,
      /where are you (currently )?(located|based)/i,
      /city\s*(of residence)?$/i,
    ],
  },
  {
    key: 'location.country',
    prompt: 'Country of residence',
    kind: 'TEXT',
    patterns: [/^country/i, /country of (residence|origin)/i],
  },
  {
    key: 'location.work_from',
    prompt: 'From where do you intend to work?',
    kind: 'TEXT',
    patterns: [/from where.*(intend|plan).*work/i, /where will you be working/i, /work location preference/i],
  },
  {
    key: 'work_auth.authorized',
    prompt: 'Are you legally authorized to work in the country this role is based in?',
    kind: 'BOOLEAN',
    // "Do you require right to work support?" asks about sponsorship, and a
    // No to "authorized?" reused there reads as "yes, sponsor me". Anything
    // asking whether you need support/sponsorship/a visa goes to the
    // sponsorship question instead - unless it asks about working *without*.
    patterns: [
      /legally\s*(authorized|authorised|entitled)\s*to\s*work/i,
      /^(?!.*\b(require|need)s?\b(?!.*\bwithout\b).*\b(support|sponsor(ship)?|assistance|visa)\b).*\b(authori[sz]ed|eligible)\s*to\s*work/i,
      /^(?!.*\b(require|need)s?\b(?!.*\bwithout\b).*\b(support|sponsor(ship)?|assistance|visa)\b).*\bright\s*to\s*work/i,
    ],
  },
  {
    key: 'work_auth.sponsorship_required',
    prompt: 'Do you now or will you in the future require visa sponsorship?',
    kind: 'BOOLEAN',
    patterns: [
      /\b(require|need)s?\b.*\bright\s*to\s*work\b.*\b(support|sponsor(ship)?|assistance|visa)\b/i,
      /require\s*(visa\s*)?sponsorship/i,
      /need\s*sponsorship/i,
      /sponsorship\s*(now|in the future|to work)/i,
      /will you (now or in the future )?require/i,
    ],
  },
  {
    key: 'work_auth.visa_status',
    prompt: 'What is your current visa / work authorization status?',
    kind: 'TEXT',
    // Word-bounded: unbounded, "tn" matched "partners" and "opt" matched
    // "option" and "opt in", so Okta's family-relationships question was
    // answered with a visa status.
    patterns: [/visa\s*(status|type)/i, /\b(h-?1b|tn|o-?1|cpt)\b/i, /\bopt\b(?![- ]?(in|out)\b)/i, /immigration status/i],
  },
  {
    key: 'experience.years_total',
    prompt: 'How many years of professional experience do you have?',
    kind: 'NUMBER',
    patterns: [
      /how many years.*(professional|relevant|total)?\s*experience/i,
      /years of experience/i,
      /^experience \(years\)/i,
    ],
  },
  {
    key: 'compensation.expectation',
    prompt: 'What are your salary expectations?',
    kind: 'TEXT',
    patterns: [
      /salary\s*(expectation|requirement|range)/i,
      /compensation\s*(expectation|requirement)/i,
      /expected\s*(salary|compensation|ctc)/i,
      /desired\s*(salary|compensation)/i,
    ],
  },
  {
    key: 'compensation.current',
    prompt: 'What is your current salary?',
    kind: 'TEXT',
    patterns: [/current\s*(salary|compensation|ctc)/i],
  },
  {
    key: 'availability.start_date',
    prompt: 'When could you start?',
    kind: 'TEXT',
    patterns: [
      /start\s*date/i, /when (can|could) you start/i, /availability to start/i, /earliest.*start/i,
      // Walmart: "What is the approximate timeline for beginning a new position with us?"
      /timeline.*(begin|start)/i, /(begin|start)(ning)? (a |the |this )?new (position|role|job)/i,
    ],
  },
  {
    key: 'availability.notice_period',
    prompt: 'What is your notice period?',
    kind: 'TEXT',
    patterns: [/notice\s*period/i, /how much notice/i],
  },
  {
    key: 'logistics.relocate',
    prompt: 'Are you willing to relocate?',
    kind: 'BOOLEAN',
    patterns: [/willing to relocate/i, /open to relocat/i, /relocation/i],
  },
  {
    key: 'logistics.onsite_hybrid',
    prompt: 'Are you able to work from the office on the required schedule?',
    kind: 'BOOLEAN',
    patterns: [/(hybrid|on-?site|in-?office).*(schedule|days|policy|able|comfortable|willing)/i, /work from the office/i],
  },
  {
    key: 'history.worked_here_before',
    prompt: 'Have you previously worked for this company (employee or contractor)?',
    kind: 'BOOLEAN',
    patterns: [/(have you|were you).*(ever )?(worked|employed).*(for|at) (us|this company|\w+) (before|previously)/i,
               /previously (worked|been employed)/i,
               /former (employee|contractor)/i,
               // Okta: "Have you been employed by Okta, Inc. or any of its subsidiaries in the past?"
               /(worked|been employed|employed) (by|for|at) .{1,80}\b(in the past|before|previously)/i,
               // Walmart: "Please select your Walmart Associate Status/Affiliation"
               /associate status/i, /(current|former|previous) associate/i],
  },
  {
    key: 'history.family_employed',
    prompt: 'Does a direct family member or relative work at the company you are applying to?',
    kind: 'BOOLEAN',
    patterns: [/(family member|relative)s?\b.*(work|employ)/i, /related to (anyone|any|an?)\b.{0,20}employee/i,
               // Okta: "do you have any family members / relatives or personal relationships at Okta ..."
               /(family members?|relatives?)\b.{0,60}\bat [A-Z]/],
  },
  {
    key: 'history.referral',
    prompt: 'Were you referred by anyone at this company?',
    kind: 'TEXT',
    patterns: [/referr?(ed|al)/i, /who referred you/i, /know anyone (who works|at)/i],
  },
  {
    key: 'history.source',
    prompt: 'How did you hear about this role?',
    kind: 'TEXT',
    patterns: [/how did you (hear|find out|learn) about/i, /where did you (hear|find)/i, /source/i],
  },
  {
    key: 'legal.age_18',
    prompt: 'Are you at least 18 years old?',
    kind: 'BOOLEAN',
    patterns: [/at least 18/i, /18 years( of age)? or older/i, /legal working age/i, /\bage (category|group|range|bracket)/i],
  },
  {
    key: 'legal.meets_min_qualifications',
    prompt: 'When you apply, do you certify you meet the posting\'s minimum qualifications?',
    kind: 'BOOLEAN',
    patterns: [/minimum (job )?qualifications/i, /meet (all )?(the )?(basic|minimum) (requirements|qualifications)/i],
  },
  {
    key: 'legal.non_compete',
    prompt: 'Are you subject to a non-compete or any agreement restricting your work?',
    kind: 'BOOLEAN',
    patterns: [/non-?compete/i, /restrictive covenant/i, /agreement.*(restrict|prevent).*(work|employ)/i],
  },
  {
    key: 'legal.background_check',
    prompt: 'Do you consent to a background check?',
    kind: 'BOOLEAN',
    patterns: [/background check/i, /criminal record/i],
  },
  // ---- Sensitive / EEO. Never inferred. Default to "decline to answer". ----
  { key: 'eeo.gender', prompt: 'Gender', kind: 'ENUM', patterns: [/^gender/i, /gender identity/i], sensitive: true },
  { key: 'eeo.race', prompt: 'Race / ethnicity', kind: 'ENUM', patterns: [/race/i, /ethnicity/i, /hispanic/i], sensitive: true },
  { key: 'eeo.veteran', prompt: 'Veteran status', kind: 'ENUM', patterns: [/veteran/i, /military service/i], sensitive: true },
  { key: 'eeo.disability', prompt: 'Disability status', kind: 'ENUM', patterns: [/disability/i, /disabled/i], sensitive: true },
  { key: 'eeo.sexual_orientation', prompt: 'Sexual orientation', kind: 'ENUM', patterns: [/sexual orientation/i, /lgbt/i], sensitive: true },
  // ---- Company-specific essays. Generated per application, never reused. ----
  {
    key: 'essay.why_company',
    prompt: 'Why do you want to work here?',
    kind: 'TEXT',
    patterns: [/why (do you want to|are you interested in) (join|work)/i, /why (this company|us|\w+)\?/i,
               /what (excites|interests) you about/i],
    perCompany: true,
  },
  {
    key: 'essay.why_role',
    prompt: 'Why are you a good fit for this role?',
    kind: 'TEXT',
    patterns: [/why (are you|do you think you).*(good |great |strong )?fit/i, /what makes you a (good|strong) candidate/i],
    perCompany: true,
  },
  {
    key: 'essay.cover_letter',
    prompt: 'Cover letter',
    kind: 'TEXT',
    patterns: [/cover\s*letter/i, /motivation letter/i],
    perCompany: true,
  },
  {
    key: 'essay.additional_info',
    prompt: 'Anything else you would like us to know?',
    kind: 'TEXT',
    patterns: [/additional information/i, /anything else/i, /other comments/i, /^comments/i],
    perCompany: true,
  },
  { key: 'file.resume', prompt: 'Resume / CV', kind: 'TEXT', patterns: [/^resume/i, /^cv$/i, /resume\s*\/\s*cv/i, /upload.*resume/i] },
];

const INDEX = new Map(CANONICAL_QUESTIONS.map((q) => [q.key, q]));
export const getCanonical = (key: string) => INDEX.get(key);

/**
 * Match a raw form label to a canonical question.
 * Returns the highest-priority match; order in CANONICAL_QUESTIONS is
 * significant (more specific questions come first within a topic).
 */
export function matchCanonical(label: string): CanonicalQuestion | undefined {
  const text = label.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  for (const q of CANONICAL_QUESTIONS) {
    for (const p of q.patterns) {
      // Regexes are shared module state; reset lastIndex defensively.
      p.lastIndex = 0;
      if (p.test(text)) return q;
    }
  }
  return undefined;
}
