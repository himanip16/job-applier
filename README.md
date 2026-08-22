# Job Applier

Fills in job applications for you: reads the real form on the real careers
page, answers what it can from your profile and resume, writes a cover letter
grounded in both, attaches your CV, and submits.

When it hits a question it cannot answer honestly, it **stops and asks you** —
then remembers your answer and never asks again, at any company, however the
next form words it.

**Read [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) first** if you want to know
what is and is not possible here. Short version: one button for any role at any
company is not achievable — the major boards ship CAPTCHA on purpose — but one
button that does everything except the five seconds a human is genuinely
required for very much is.

---

## How it decides what to type

Every field goes through the same ladder, cheapest and most trustworthy first.
It stops at the first rung that produces an answer.

| # | Source | What it is |
|---|---|---|
| 1 | `PROFILE` | Structured profile data. Name, email, phone, location, links. No model, no ambiguity. |
| 2 | *sensitive* | Demographic/EEO questions. Never inferred. Takes the form's own "decline to self-identify" option. |
| 3 | `RULE` | A fact you stated, matched to the question by a deterministic rule. ~20 rules cover most of what forms ask. |
| 4 | `GENERATED` | Employer-specific free text ("why do you want to work here"). Written fresh per application, never recycled. |
| 5 | `MEMORY` | You have answered this before. Matched by canonical key, exact wording, or lexical similarity. |
| 6 | `INFERRED` | Claude derived it from your resume, above a confidence threshold, with the evidence recorded. |
| 7 | **ask you** | Everything else. The run pauses with the browser open and the form half-filled. |

Rungs 1–5 cost nothing and are instant. The model is consulted only for what
they miss, and it is instructed that refusing is the correct answer whenever
the information is not actually there.

---

## Setup

Requires Node 22+, pnpm, and Postgres 14+.

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL and ANTHROPIC_API_KEY
pnpm db:push
pnpm --filter @ja/server seed # optional: a starter profile and standing answers
npx playwright install chromium
```

Run the two processes:

```bash
pnpm dev:server   # API + run engine on :8787
pnpm dev:web      # UI on :3000
```

Then open <http://localhost:3000>, fill in your profile, upload your resume,
and paste a job URL.

### Settings that matter

| Variable | Default | Why you care |
|---|---|---|
| `HEADLESS` | `false` | **Keep it false.** A visible, persistent profile passes invisible CAPTCHA far more often, and it is the only way you can take over when a challenge appears. |
| `REQUIRE_REVIEW` | `true` | Every application stops for your approval before submitting. Turn it off only once you trust it. |
| `MAX_SUBMITS_PER_HOUR` | `10` | Hard cap. Exists so a bug cannot send fifty applications in your name. |
| `ANSWER_CONFIDENCE_THRESHOLD` | `0.82` | Below this the resolver asks you instead of guessing. |
| `MEMORY_REUSE_THRESHOLD` | `0.86` | How similar a past question must be before its answer is reused. |
| `CHROMIUM_EXECUTABLE_PATH` | unset | Point at a Chromium you already have, if Playwright's download is blocked. |

---

## Supported sites

| Adapter | Coverage | Notes |
|---|---|---|
| `greenhouse` | `job-boards.greenhouse.io`, `boards.greenhouse.io`, embeds | Dropdowns are react-select comboboxes, not `<select>`. reCAPTCHA present. |
| `lever` | `jobs.lever.co` | Native HTML form throughout — the most reliable to drive. hCaptcha present. |
| `ashby` | `jobs.ashbyhq.com` | Generated DOM, unstable ids; matched by label. |
| `workable` | `apply.workable.com` | Drop-zone resume upload over a hidden file input. |
| `generic` | anything else | No site knowledge; labels only. Always routed through review. |

Adding one means implementing five methods in `apps/server/src/ats/types.ts`.
The generic extractor and fill engine do the heavy lifting.

---

## The command line, if you prefer it

```bash
pnpm --filter @ja/server apply -- https://jobs.lever.co/acme/1234/apply
```

Questions are asked on stdin, the filled values are printed for approval before
submitting, and answers go into the same bank the UI uses.

---

## Layout

```
packages/shared/     Zod field schema, canonical question rules, label matching
apps/server/
  browser/           Playwright: extract, fill, verify, detect blockers
  ats/adapters/      Per-board knowledge
  engine/            Resolver, answer bank, run state machine, queue
  llm/               Claude: cover letters, essays, answer inference
  index.ts           Fastify API + SSE
apps/web/            Next.js UI: profile, live run view, question popup, answer bank
fixtures/            Offline replicas of real Greenhouse and Lever DOM
```

---

## Tests

```bash
createdb job_applier_test
DATABASE_URL="postgresql://.../job_applier_test" pnpm db:push
pnpm --filter @ja/server test
```

The integration suite truncates tables, so it refuses to run unless the
database name ends in `_test` — set `TEST_DATABASE_URL` in your `.env` and the
test script picks it up automatically.

24 tests, no network and no API key required. They run the real extractor and
the real fill engine against `fixtures/`, which reproduce the DOM contracts read
off live Greenhouse and Lever forms in August 2026 — react-select comboboxes,
hidden file inputs, radio groups, captcha markers and all. `endToEnd.test.ts`
drives a complete run against a real Postgres and a real browser, including the
pause-ask-remember loop, with only the Anthropic calls stubbed.

---

## Things it deliberately will not do

- **Solve CAPTCHAs**, via a service or otherwise. It detects them and hands you
  the filled form.
- **Guess demographic answers.** Gender, race, disability and veteran status
  default to declining to self-identify unless you record an answer yourself.
- **Invent facts.** The cover letter generator reports any claim it could not
  ground in your resume, and the answer resolver refuses rather than
  approximating.
- **Touch LinkedIn Easy Apply or Indeed.** Their terms prohibit it and they
  enforce it against your account.
- **Claim a submission it cannot see.** Without positive confirmation on the
  page, the run ends in `NEEDS_HUMAN`, not `SUBMITTED`.
