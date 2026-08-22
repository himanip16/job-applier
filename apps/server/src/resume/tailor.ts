import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { normalizeLabel } from '@ja/shared';
import { llm, MODEL, describeLlmError } from '../llm/client.js';

/**
 * Rewriting a resume for one job, without lying on it.
 *
 * The whole design turns on one rule: **a keyword may only appear in the
 * tailored resume if the candidate's own material already supports it.**
 *
 * That is not a stylistic preference. A resume is a factual claim you sign, an
 * interviewer will ask you about anything on it, and "the tool added Kubernetes
 * because the job wanted Kubernetes" is a terrible thing to discover in a
 * technical screen. So keywords are sorted into three buckets before a single
 * word is rewritten:
 *
 *   covered      - already in the resume. Possibly worth surfacing better.
 *   grounded     - missing from the resume, but the evidence exists in the
 *                  candidate's other material. Safe to add, and every addition
 *                  is recorded with the evidence that justified it.
 *   unsupported  - no evidence anywhere. NEVER written in. Reported back as a
 *                  genuine gap, which is information the candidate can act on.
 *
 * The rewrite step is then a separate call that is handed only the grounded
 * list and is told it may not introduce anything else. Two calls rather than
 * one, because a single prompt asking a model to both find gaps and fill them
 * gives it every incentive to blur the line between the two.
 */


/**
 * Does this text mention this keyword?
 *
 * A literal substring test is not enough: the rewrite legitimately turns
 * "mentoring" into "mentored" and "containers" into "containerised", and a
 * strict match would both under-count real insertions and, worse, miss an
 * unsupported keyword that arrived in an inflected form. So each word is
 * reduced to a crude stem and matched at a word boundary.
 *
 * The stemming is deliberately blunt. On the violation path a false positive
 * costs a warning the candidate can dismiss; a false negative ships a claim
 * they cannot back up. Bias toward catching things.
 */
export function mentionsKeyword(text: string, keyword: string): boolean {
  const words = normalizeLabel(keyword).split(' ').filter(Boolean);
  if (!words.length) return false;
  const haystack = normalizeLabel(text);
  return words.every((w) => {
    const stem = crudeStem(w);
    if (stem.length < 3) return new RegExp(`\\b${escapeRe(w)}\\b`).test(haystack);
    return new RegExp(`\\b${escapeRe(stem)}`).test(haystack);
  });
}

function crudeStem(w: string): string {
  return w
    .replace(/(ising|izing|ising|ation|ations)$/, '')
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/([a-z])\1$/, '$1');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- step one ---

const KeywordAnalysisSchema = z.object({
  covered: z
    .array(
      z.object({
        keyword: z.string(),
        where: z.string().describe('The phrase in the resume that already covers it.'),
      }),
    )
    .describe('Keywords the job asks for that the resume already demonstrates.'),
  grounded: z
    .array(
      z.object({
        keyword: z.string(),
        evidence: z
          .string()
          .describe('The exact text from the candidate material that supports this. Quote it.'),
        sourceField: z
          .string()
          .describe('Where the evidence came from: resume, summary, or the fact key.'),
        suggestion: z
          .string()
          .describe('How to word it, staying strictly within what the evidence supports.'),
      }),
    )
    .describe(
      'Keywords absent from the resume but genuinely supported by the candidate material. Every one needs a real quote.',
    ),
  unsupported: z
    .array(
      z.object({
        keyword: z.string(),
        importance: z.enum(['REQUIRED', 'PREFERRED', 'NICE_TO_HAVE']),
        note: z.string().describe('What the job wants, and what the candidate has instead, if anything.'),
      }),
    )
    .describe('Keywords the job wants that nothing in the candidate material supports.'),
  atsIssues: z
    .array(z.string())
    .describe('Formatting or structural problems that would hurt an ATS parse of this resume.'),
});

export type KeywordAnalysis = z.infer<typeof KeywordAnalysisSchema>;

const ANALYSIS_SYSTEM = `You compare one job description against one candidate's material and sort the job's keywords into three buckets. You do not write anything yet.

The buckets:

- covered: the resume already demonstrates this. Quote the phrase that does.
- grounded: the resume does not say it, but the candidate's material genuinely supports it. This bucket requires a VERBATIM QUOTE from the supplied material. If you cannot quote it, it does not belong here.
- unsupported: nothing in the material supports it.

The line between "grounded" and "unsupported" is the only thing that matters in this task, and you must be strict about it:

- "Built REST APIs in Django" grounds "Python" and "REST". It does not ground "FastAPI".
- "Led a team of six" grounds "leadership" and "mentoring". It does not ground "hiring" or "performance management".
- "Deployed to AWS ECS" grounds "AWS" and "containers". It does not ground "Kubernetes" — those are different technologies, and an interviewer will find out.
- Five years at a fintech grounds "financial services domain". It does not ground "PCI compliance" unless compliance work is stated.

An adjacent technology is not evidence. A plausible inference is not evidence. If the candidate would be unable to answer a follow-up question about it in an interview, it is unsupported.

Putting something in unsupported is a useful result, not a failure: it tells the candidate exactly what this job wants that they do not have. Over-grounding is the only real failure mode here.

Pull keywords that an ATS or a recruiter would actually screen on: technologies, methodologies, domain terms, certifications, seniority markers, the concrete responsibilities. Ignore boilerplate about culture and benefits.`;

export async function analyseKeywords(args: {
  candidateContext: string;
  resumeText: string;
  jobTitle: string;
  companyName: string;
  jobDescription: string;
}): Promise<KeywordAnalysis> {
  try {
    const res = await llm().messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: ANALYSIS_SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: zodOutputFormat(KeywordAnalysisSchema) },
      messages: [
        {
          role: 'user',
          content: `${args.candidateContext}

<current_resume>
${args.resumeText.slice(0, 20000)}
</current_resume>

<job>
title: ${args.jobTitle}
company: ${args.companyName}

${args.jobDescription.slice(0, 15000)}
</job>

Sort this job's keywords into the three buckets.`,
        },
      ],
    });
    const parsed = res.parsed_output;
    if (!parsed) throw new Error('Keyword analysis returned no parseable output.');
    return parsed;
  } catch (err) {
    throw new Error(describeLlmError(err));
  }
}

// ---------------------------------------------------------------- step two ---

const RewriteSchema = z.object({
  text: z.string().describe('The complete tailored resume as ATS-safe plain text.'),
  changes: z
    .array(
      z.object({
        keyword: z.string(),
        before: z.string().describe('The original line, or empty if this is a new line.'),
        after: z.string().describe('The rewritten line.'),
      }),
    )
    .describe('Every edit made, one per item.'),
});

const REWRITE_SYSTEM = `You rewrite a resume so it reads well to both an ATS parser and a human, for one specific job.

You are given an allow-list of keywords, each with the evidence that justifies it. Those are the only additions permitted.

Hard rules:
- Do not introduce any skill, technology, employer, title, date, metric or outcome that is not in the original resume or in the allow-list. Not one.
- Do not change dates, employer names or job titles. Ever.
- Do not invent numbers. If the original says "improved latency", it still says "improved latency"; it does not become "improved latency by 40%".
- Every allow-list keyword you use must be worded within what its evidence supports. The evidence is a ceiling, not a starting point.
- You may reorder, reword, re-emphasise, tighten and cut. That is most of the value.

ATS-safe formatting, because this is what actually gets parsed:
- Single column, no tables, no columns, no text boxes, no headers or footers, no graphics.
- Standard section headings, spelled the boring way: SUMMARY, EXPERIENCE, SKILLS, EDUCATION, PROJECTS, CERTIFICATIONS.
- One bullet per line, starting with "- ". No fancy glyphs, no tabs.
- Contact details as plain lines at the top. No icons.
- Dates as "Mon YYYY - Mon YYYY" or "Mon YYYY - Present".
- Spell out an acronym once alongside its short form where the job uses both, e.g. "Continuous Integration (CI)": parsers match literally and recruiters search both.
- No stuffing. Repeating a keyword eight times reads as spam to a human, and modern parsers do not reward it.

Lead each experience bullet with a strong verb and, where the original already gives one, a concrete result.`;

export interface TailorResult {
  text: string;
  insertions: { keyword: string; evidence: string; sourceField: string; line: string }[];
  unsupported: { keyword: string; importance: string; note: string }[];
  covered: { keyword: string; where: string }[];
  coverage: number;
  atsIssues: string[];
  /** Populated when a keyword slipped through that we could not verify. */
  violations: string[];
}

export async function tailorResume(args: {
  candidateContext: string;
  resumeText: string;
  jobTitle: string;
  companyName: string;
  jobDescription: string;
}): Promise<TailorResult> {
  const analysis = await analyseKeywords(args);

  // Nothing to add: still worth returning the analysis so the candidate sees
  // the gaps, but do not pay for a rewrite that would only churn wording.
  const allowList = analysis.grounded;

  let text = args.resumeText;
  let changes: { keyword: string; before: string; after: string }[] = [];

  if (allowList.length > 0 || analysis.atsIssues.length > 0) {
    try {
      const res = await llm().messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: REWRITE_SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: zodOutputFormat(RewriteSchema) },
        messages: [
          {
            role: 'user',
            content: `<original_resume>
${args.resumeText.slice(0, 20000)}
</original_resume>

<target_job>
${args.jobTitle} at ${args.companyName}
</target_job>

<allowed_additions>
${
  allowList.length
    ? allowList
        .map(
          (g) =>
            `- ${g.keyword}\n  evidence: "${g.evidence}" (${g.sourceField})\n  suggested wording: ${g.suggestion}`,
        )
        .join('\n')
    : 'None. Do not add any keywords; reformat and tighten only.'
}
</allowed_additions>

<already_covered_do_not_duplicate>
${analysis.covered.map((c) => `- ${c.keyword}`).join('\n') || 'none'}
</already_covered_do_not_duplicate>

<ats_issues_to_fix>
${analysis.atsIssues.join('\n') || 'none'}
</ats_issues_to_fix>

Rewrite the resume.`,
          },
        ],
      });
      const parsed = res.parsed_output;
      if (parsed?.text) {
        text = parsed.text;
        changes = parsed.changes;
      }
    } catch (err) {
      throw new Error(describeLlmError(err));
    }
  }

  // ---- the check that makes the promise real -----------------------------
  //
  // The prompt says "do not add anything unsupported". Prompts are not
  // guarantees, so verify: every unsupported keyword must be absent from the
  // output unless it was already in the original. Anything that slipped
  // through is stripped from the claim list and reported loudly rather than
  // shipped quietly.
  const violations: string[] = [];
  for (const u of analysis.unsupported) {
    if (!u.keyword.trim()) continue;
    const wasThere = mentionsKeyword(args.resumeText, u.keyword);
    const isThereNow = mentionsKeyword(text, u.keyword);
    if (isThereNow && !wasThere) {
      violations.push(u.keyword);
    }
  }

  const insertions = allowList
    .filter((g) => mentionsKeyword(text, g.keyword))
    .map((g) => ({
      keyword: g.keyword,
      evidence: g.evidence,
      sourceField: g.sourceField,
      line: changes.find((c) => c.keyword === g.keyword)?.after ?? g.suggestion,
    }));

  const totalKeywords =
    analysis.covered.length + analysis.grounded.length + analysis.unsupported.length;
  const coverage = totalKeywords
    ? ((analysis.covered.length + insertions.length) / totalKeywords) * 100
    : 0;

  return {
    text,
    insertions,
    unsupported: analysis.unsupported,
    covered: analysis.covered,
    coverage,
    atsIssues: analysis.atsIssues,
    violations,
  };
}
