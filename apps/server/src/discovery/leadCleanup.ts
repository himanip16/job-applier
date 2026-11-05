/**
 * Bulk triage for a queue that has drifted.
 *
 * A broad search buys reach and pays for it in noise: ask for "software
 * engineer" across a hundred boards and you get account executives, quant
 * traders, mechanical engineers, Tokyo, and a directorship. None of those are
 * judgement calls for this candidate, and none of them should cost a model
 * call to dismiss - so they are dismissed here, by rule, in one pass.
 *
 * The rules are deliberately the *obvious* ones only. Anything that needs a
 * read of the posting is left alone for the scorer, because the cost of the
 * two mistakes is not symmetric: a wrongly-kept lead costs one glance, and a
 * wrongly-cut one costs an opening you never saw.
 */

import { countryByCode, locatedIn } from '@ja/shared';
import { parseRequiredYears } from './hardRules.js';

/** Matches the coarse buckets offered in the UI, so the two agree. */
export type CleanupCategory = 'Wrong domain' | 'Too senior' | 'Too junior' | 'Location or commute';

export interface CleanupVerdict {
  category: CleanupCategory;
  /** One sentence, in the candidate's voice - it becomes a training signal. */
  reason: string;
  /** Which rule fired, for the report. */
  rule: string;
}

export interface CleanableLead {
  title: string;
  location: string | null;
  descriptionText: string | null;
  remote: boolean;
}

// ------------------------------------------------------------- wrong domain ---

/**
 * Titles that are not this job.
 *
 * Grouped by what the role actually is, because the groups are what you want
 * to read in a report - "412 sales" tells you your search queries are wrong,
 * where "412 rejected" tells you nothing.
 */
/**
 * A title that names a software role outright. "Senior Fullstack Engineer,
 * Marketing" is an engineer on the marketing team, not a marketer - but a bare
 * "Engineer" is not enough, or "Solutions Engineer" and "Support Engineer"
 * would pass too.
 */
const SOFTWARE_ROLE = /\b(software|full[- ]?stack|back[- ]?end|front[- ]?end|developer|programmer|sde|swe)\b/i;

const WRONG_DOMAIN: { rule: string; pattern: RegExp; unless?: RegExp }[] = [
  {
    rule: 'sales',
    pattern:
      /\b(account (executive|manager|director|partner)|sales|seller|business development|bdr|sdr|quota|revenue (manager|lead)|gtm|go[- ]to[- ]market|pre[- ]?sales|solutions? (engineer|architect|consultant|specialist)|customer success|technical account|renewals?|channel (manager|partner)|partnerships?|commercial (manager|director|lead)|growth (manager|lead|marketer))\b/i,
  },
  {
    rule: 'marketing & comms',
    pattern:
      /\b(marketing|brand|content (writer|strategist|manager|designer)|copywriter|communications|public relations|social media|seo|demand gen|events? (manager|coordinator)|community manager)\b/i,
    unless: SOFTWARE_ROLE,
  },
  {
    rule: 'design',
    pattern:
      /\b(designer|graphic|illustrat|ux researcher|user experience researcher|creative director|art director|motion|brand design)\b/i,
    unless: SOFTWARE_ROLE,
  },
  {
    rule: 'people, legal & finance',
    pattern:
      /\b(recruit|talent acquisition|sourcer|people (partner|operations|team)|hr\b|human resources|counsel|legal|paralegal|attorney|accountant|controller|bookkeep|payroll|auditor|tax\b|treasury|procurement|facilities|office manager|executive assistant|chief of staff|workplace)\b/i,
    unless: SOFTWARE_ROLE,
  },
  {
    rule: 'finance & trading',
    pattern:
      /\b(quantitative|quant\b|trader|trading|portfolio manager|investment|investor|banking|equity research|actuar|underwrit|credit risk|fp&a|financial (analyst|planning))\b/i,
    // "Quantitative Developer" and "C++ Engineer, Trading Systems" are the
    // engineering jobs at the quant firms this search targets.
    unless: /\b(developer|engineer|engineering|programmer|software|sde|swe)\b/i,
  },
  {
    rule: 'enterprise platform configuration',
    // A platform's name followed by a platform role: "Workday Extend
    // Developer", "SAP ABAP Consultant", "Salesforce Apex Developer". Not a
    // software engineer who happens to work at Workday or ServiceNow.
    pattern:
      /\b(workday|sap|salesforce|servicenow|oracle (ebs|fusion|apps|hcm|erp)|dynamics 365|d365|netsuite|peoplesoft|sharepoint|power (apps|platform|bi)|mulesoft|pega|appian|outsystems|guidewire|siebel|coupa|ariba|successfactors|veeva|tableau)\s+(extend|hcm|hris|integrations?|abap|apex|cpq|crm|erp|functional|technical|admin|administrator|consultant|developer|platform developer|workflow|reporting|analyst|lead|specialist|architect|financials?)\b/i,
  },
  {
    rule: 'support & operations',
    pattern:
      /\b(technical support|support (engineer|specialist|agent|advocate|analyst)|help ?desk|service desk|customer (support|service|experience|care)|operations (analyst|specialist|associate|coordinator|executive)|business operations|coordinator|administrator|receptionist|dispatch)\b/i,
  },
  {
    rule: 'analyst & consulting',
    pattern:
      /\b(business analyst|\bba\b|data analyst|analytics (manager|lead)|insights analyst|strategy (manager|lead|associate)|strategist|consultant|advisory|program manager|project manager|product manager|product owner|scrum master|delivery (manager|lead)|engagement manager)\b/i,
  },
  {
    rule: 'research & data science',
    pattern:
      /\b(research (scientist|engineer|associate|fellow)|researcher|applied scientist|data scientist|research intern|post[- ]?doc|phd\b)\b/i,
  },
  {
    rule: 'hardware & non-software engineering',
    pattern:
      /\b(mechanical|electrical|electronics|hardware|firmware|embedded|asic|fpga|verilog|rtl design|silicon|semiconductor|photonic|optical|thermal|civil|structural|chemical|process engineer|manufacturing|industrial|packaging|robotics technician|technician|field service|maintenance|welding|cnc|hvac|automotive|aerospace|avionics|geotechnical|mining|drilling)\b/i,
  },
  {
    rule: 'qa & test',
    pattern:
      /\b(qa\b|quality (assurance|engineer|engineering)|sdet|engineer in test|developer in test|test engineer|test automation|automation (tester|qa|test engineer)|tester|manual testing|test lead|test analyst)\b/i,
  },
  {
    rule: 'outside tech entirely',
    pattern:
      /\b(nurse|physician|doctor|clinical|pharmac|dentist|therapist|veterinar|teacher|tutor|lecturer|professor|driver|courier|warehouse|picker|barista|chef|cook|waiter|bartender|housekeep|janitor|security guard|cleaner|retail associate|store manager|cashier|flight attendant|pilot|paramedic|firefighter|police)\b/i,
  },
];

/** The kind of non-engineering job a title describes, or null if it could be one. */
export function wrongDomain(title: string): string | null {
  return WRONG_DOMAIN.find(({ pattern, unless }) => pattern.test(title) && !unless?.test(title))?.rule ?? null;
}

// -------------------------------------------------------------- seniority ---

/**
 * Titles asking for someone further along.
 *
 * "Lead" and "architect" are in here on purpose: both are real jobs and
 * neither is a 4-5 year job. "Senior" is deliberately *not* - SE2/SSE at four
 * and a half years is exactly the band being searched for.
 */
const TOO_SENIOR =
  /\b(staff|principal|distinguished|fellow|architect|director|vp|vice president|head of|chief|cto|cio|ciso|cpo|coo|ceo|president|partner|manager|management|lead|leader|senior manager|group manager|dept|department head|founding engineer)\b/i;

/**
 * Below this, a staff, lead, architect or manager title is a level up rather
 * than the next step. Unknown years are treated as under it: the rule was
 * written for a four-to-five-year search.
 */
const SENIOR_TITLE_YEARS = 7;

/**
 * A title pitched at a different level from the candidate, as a short tag for
 * a card and a sentence for its tooltip.
 *
 * The quick score needs this as much as the cleanup script does. Without it a
 * "Cloud Architect" shares "cloud" with a backend resume and ranks at the top,
 * because word overlap cannot tell an architect role from an engineering one.
 */
export function levelMismatch(
  title: string,
  candidateYears: number | null,
): { tag: string; reason: string } | null {
  if ((candidateYears === null || candidateYears < SENIOR_TITLE_YEARS) && TOO_SENIOR.test(title)) {
    const level = title.match(TOO_SENIOR)![0].toLowerCase();
    return { tag: 'too senior', reason: `A ${level} title: a level above ${candidateYears ?? 'your'} years.` };
  }
  return null;
}

/**
 * Roles that are still an education. "Placement", "student" and "campus" only
 * with the word that makes them one, so Ads Placement or Campus Security
 * engineering is not caught.
 */
const TOO_JUNIOR =
  /\b(intern|internship|co[- ]?op|new grad|graduate (programme|program|scheme|engineer|analyst|developer|role)|grad\b|apprentice|apprenticeship|trainee|placement (year|student|programme|program)|(year|industrial|summer) placement|working student|student (developer|engineer|programmer|assistant|worker)|campus (hire|hiring|recruit\w*|program\w*)|university (programme|program|hire|graduate)|entry[- ]level|fresher|20(2[6-9]|3\d)\s*(grad|graduate|start|cohort)?)\b/i;

/** An internship, graduate scheme or entry-level title. */
export function isJuniorRole(title: string): boolean {
  return TOO_JUNIOR.test(title);
}

/**
 * Years the candidate has. Passed in rather than parsed here so one number
 * covers the whole batch and the caller can see what it used.
 */
const YEARS_TOLERANCE = 1;

// ---------------------------------------------------------------- location ---

const INDIA =
  /\b(india|bengaluru|bangalore|gurugram|gurgaon|hyderabad|pune|mumbai|bombay|new delhi|delhi|noida|chennai|madras|kolkata|calcutta|ahmedabad|jaipur|kochi|cochin|coimbatore|thiruvananthapuram|trivandrum|indore|chandigarh|nagpur|vadodara|bhubaneswar|mysore|mysuru|visakhapatnam|surat|lucknow)\b/i;

/**
 * A posting that says it will move you, or sponsor you.
 *
 * Kept even when it is abroad, because these are the only foreign roles an
 * Indian candidate can actually take - cutting them would remove the exact
 * openings that solve the problem the country rule exists for.
 */
const OFFERS_RELOCATION =
  /\b(relocation (provided|support|assistance|package|offered|available)|will relocate|we relocate|visa sponsorship (is )?(available|offered|provided)|sponsorship (is )?(available|offered|provided)|we sponsor|able to sponsor|work permit (provided|sponsored))\b/i;

/**
 * Somewhere that is not India and not open-ended remote.
 *
 * Bare "Remote" passes: plenty of those are global, and the ones that are not
 * say so in the body, which is the scorer's job to read. A location naming a
 * foreign place does not pass, whatever else it says.
 */
const FOREIGN_PLACE =
  /\b(united states|u\.?s\.?a?\b|usa|canada|mexico|brazil|argentina|chile|colombia|united kingdom|u\.?k\.?\b|england|scotland|wales|ireland|france|germany|spain|portugal|italy|netherlands|belgium|luxembourg|switzerland|austria|poland|czech|slovak|hungary|romania|bulgaria|greece|turkey|sweden|norway|denmark|finland|iceland|estonia|latvia|lithuania|ukraine|israel|uae|dubai|abu dhabi|saudi|qatar|doha|bahrain|kuwait|egypt|nigeria|kenya|south africa|australia|new zealand|japan|tokyo|osaka|china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|singapore|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|vietnam|hanoi|philippines|manila|south korea|korea|seoul|pakistan|bangladesh|sri lanka|nepal|new york|san francisco|bay area|seattle|austin|boston|chicago|denver|atlanta|los angeles|san jose|palo alto|mountain view|menlo park|sunnyvale|santa clara|cupertino|redmond|washington,? d\.?c|dallas|houston|phoenix|portland|miami|philadelphia|pittsburgh|detroit|minneapolis|salt lake|san diego|toronto|vancouver|montreal|ottawa|london|manchester|edinburgh|dublin|cambridge|oxford|paris|berlin|munich|hamburg|frankfurt|stuttgart|amsterdam|rotterdam|brussels|zurich|geneva|vienna|madrid|barcelona|lisbon|milan|rome|warsaw|cracow|krakow|prague|budapest|bucharest|sofia|athens|stockholm|oslo|copenhagen|helsinki|tallinn|riga|vilnius|kyiv|tel aviv|istanbul|cairo|lagos|nairobi|cape town|johannesburg|sydney|melbourne|brisbane|perth|auckland|wellington|s[ãa]o paulo|rio de janeiro|buenos aires|santiago|bogot[áa]|lima|mexico city|guadalajara|monterrey|emea|apac|latam|anz)\b/i;

/** US state codes, only where a comma makes them a location. */
const US_STATE =
  /,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;

// ------------------------------------------------------------------ verdict ---

/**
 * The one thing wrong with this lead, or nothing.
 *
 * First match wins, in an order chosen so the label is the most useful thing
 * you could be told: what the role *is* beats where it is, because a Tokyo
 * account executive is not a location problem.
 */
export function cleanupVerdict(
  lead: CleanableLead,
  candidateYears: number | null,
): CleanupVerdict | null {
  const title = lead.title;
  const body = lead.descriptionText ?? '';
  const where = `${lead.location ?? ''}`;

  const domain = wrongDomain(title);
  if (domain) {
    return {
      category: 'Wrong domain',
      reason: `Not a software engineering role — this is ${domain}.`,
      rule: `domain:${domain}`,
    };
  }

  if (TOO_SENIOR.test(title)) {
    return {
      category: 'Too senior',
      reason: `Title is a level above where I am — staff/lead/management scope.`,
      rule: 'seniority:title',
    };
  }

  if (TOO_JUNIOR.test(title)) {
    return {
      category: 'Too junior',
      reason: `Internship or new-graduate role; I am already ${candidateYears ?? 'several'} years in.`,
      rule: 'seniority:junior',
    };
  }

  // Only now the body, because it is the expensive test and the cheap ones
  // have already removed most of the queue.
  if (candidateYears !== null && body) {
    const required = parseRequiredYears(`${title}\n${body}`);
    if (required !== null && required - candidateYears > YEARS_TOLERANCE) {
      return {
        category: 'Too senior',
        reason: `Asks for ${required}+ years and I have ${candidateYears}.`,
        rule: 'seniority:years',
      };
    }
  }

  if (locationIsWrong(where, body)) {
    return {
      category: 'Location or commute',
      reason: `Based in ${where.trim() || 'another country'}; I am in India and would need sponsorship, which this does not offer.`,
      rule: 'location:foreign',
    };
  }

  return null;
}

/** A location line naming a region that takes India, or none at all. */
const OPEN_REGION = /\b(apac|asia|asia[- ]pacific|worldwide|global|anywhere)\b/i;

/**
 * A body that says the role is remote from anywhere. Specific phrases only:
 * "customers worldwide" in a company blurb says nothing about who can apply.
 */
const REMOTE_ANYWHERE =
  /\b(work from anywhere|anywhere in the world|remote[- ](worldwide|globally|anywhere)|(worldwide|global(ly)?|fully)[- ]remote,? (from )?(any|all) (countr|time ?zone)|(worldwide|global)[- ]remote|location:? (anywhere|worldwide|global))/i;

const INDIA_COUNTRY = countryByCode('IN')!;

/**
 * Could someone living in India take this job?
 *
 * Yes when it is in India, open to remote work from India or from anywhere,
 * or abroad with sponsorship or relocation on offer. A worldwide search keeps
 * only these. Bare "Remote" and no location at all are kept, as they are
 * everywhere else: they cannot be ruled out from the location line.
 */
export function openToIndia(location: string | null | undefined, remote: boolean, body: string): boolean {
  const where = location ?? '';
  const head = body.slice(0, 4000);
  if (INDIA.test(where) || INDIA.test(head)) return true;
  if (OFFERS_RELOCATION.test(where) || OFFERS_RELOCATION.test(body)) return true;
  if (OPEN_REGION.test(where) && (remote || /\bremote\b/i.test(where) || !FOREIGN_PLACE.test(where.replace(OPEN_REGION, '')))) return true;
  if (REMOTE_ANYWHERE.test(head)) return true;
  if (FOREIGN_PLACE.test(where) || US_STATE.test(where)) return false;
  return locatedIn(where, remote, INDIA_COUNTRY);
}

function locationIsWrong(where: string, body: string): boolean {
  if (INDIA.test(where)) return false;
  // A posting listing several offices including an Indian one is reachable.
  if (INDIA.test(body.slice(0, 2000))) return false;
  if (!where.trim()) return false; // Nothing to judge; leave it to the scorer.
  if (!FOREIGN_PLACE.test(where) && !US_STATE.test(where)) return false;
  // The exception that makes the rule fair.
  if (OFFERS_RELOCATION.test(body) || OFFERS_RELOCATION.test(where)) return false;
  return true;
}
