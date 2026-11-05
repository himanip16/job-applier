# Job Applier

Runs a job search end to end: finds the openings, ranks them against what you
actually want, fills in the applications, tailors your resume for each one, and
keeps a record of what happened.

Four parts:

1. **Find work** — reads target-company careers sources for openings matching your resume, with
   no list of companies from you, and puts the plausible ones in a triage
   queue. Reject one and say why, and the ranking moves; the sibling job two
   rows down re-ranks immediately.
2. **Apply** — drives the real form in a real browser, answers what it can, and
   **stops and asks you** when it cannot answer honestly. Your answer is
   remembered forever, at any company, however the next form words it.
3. **Tailor the resume** — pulls the keywords a screener looks for and adds only
   the ones your own material actually supports. Every addition carries its
   evidence; everything it cannot ground is reported as a gap rather than
   quietly written in.
4. **Track** — outcomes, interview rounds, the questions you were asked, and
   what you think you got wrong.

**Read [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) first** if you want to know
what is and is not possible here. Short version: one button for any role at any
company is not achievable — the major boards ship CAPTCHA on purpose — but one
button that does everything except the five seconds a human is genuinely
required for very much is.

---

## Finding work

Press **Find jobs for me** and choose a country. The app derives role titles
from your resume, preferences and decisions, then reads the 100 companies in
`companies_50lpa.json`, ordered by their listed compensation ceiling. Companies
without a configured careers source are listed separately and are not crawled.

Sources include public ATS board APIs, company careers backends (including
Amazon, Workday, Google and Eightfold), and a browser crawler for configured
careers-page URLs. Find Work uses these sources directly and does not require
Firecrawl search credits. Coverage depends on each source's query, paging and
detail limits; a successful request does not guarantee a complete company list.

The report shows postings fetched before filtering, postings that passed,
new leads saved, duplicates, filter exclusions with example titles, and every
company attempted. Source failures, query/detail limits and missing descriptions
are visible under **Source coverage**. Companies with no careers source appear
in their own list rather than being counted as failures.

Titles are normalized across common aliases such as SDE, MTS and Developer.
A generic title such as Software Engineer II can also match a backend plan when
its description names backend or server-side work. Explicitly different roles
still have to pass the title gate. Existing country, age and seniority filters
continue to apply.

Every admitted posting gets a lexical score. After each search, the top 25
unread leads in the queue, old and new, get a model assessment by default. A
company gets at most 3 of those reads, and titles already capped as off-role
are skipped. A keyword-only score is pulled toward the middle so it stays under
70: only a model read can rank a job as a strong match or above one the model
read. Scores rank jobs without dismissing them or
changing your saved, applied or rejected decisions. Older automatically dismissed
jobs remain in Dismissed, but their recorded automatic reasons are excluded from
both search-planning and fit-assessment preference history.

### How the ranking learns

Two layers you can inspect:

- **A weighted-term model built from your own decisions.** Reject a job and the
  terms that characterise it get pushed down; a reason you type pushes the terms
  you named down about three times harder. Steps decay as evidence accumulates,
  so the fortieth rejection nudges rather than lurches, and weights are clamped
  so no single word becomes a veto. Every weight is a row you can read, edit or
  delete on the `/discover` page.
- **A model pass** that sees your profile, your stated preferences, and a
  summary of what you have been turning down, and reads the actual description.
  That is where "is this really backend or is it devops?" gets decided.

The reason box is optional and says so. Forcing one gets you "n/a", and "n/a"
is worse than silence because the learner would treat it as signal.

---

## Applications are wizards, not forms

Almost no real application is one page with a Submit button. Workday walks you
through My Information, My Experience, Application Questions, Voluntary
Disclosures and Review. Taleo and iCIMS want an account first. Several ask,
before showing you anything, whether to parse your resume and fill it all in.

So the engine walks it one screen at a time:

```
open  ->  [ wall? -> you clear it, it carries on ]
      ->  [ "autofill with your resume?" -> answer it ]
      ->  read this screen -> resolve -> ask you what it cannot answer -> fill
      ->  find what moves forward -> press it -> did anything change?
      ->  ...until the control that ends the application
```

A single-page Greenhouse form is just the one-step case of the same loop.

Some details that took a fixture to get right:

- **Knowing whether "Continue" did anything.** The URL is identical across all
  six steps of a single-page app, so movement is judged on a fingerprint of the
  path, the visible heading and the field labels. When it does not move, the
  page's own complaint is reported — including native constraint messages,
  which render no markup at all — rather than "nothing happened".
- **A login is a pause, not an end.** It nudges you, you do the one thing, and
  it continues on its own. The browser window holding the page is raised, the
  terminal beeps, and a bar appears on every page of the UI naming the run and
  linking straight to it (with a desktop notification if you allow one). Then
  the run watches that page: the moment the wall is gone it carries on by
  itself — no coming back to press anything. **Done — carry on** is still there
  for walls it cannot see the end of, next to **Cancel**. The browser profile
  persists, so you sign in once per site, not once per application.
- **Only the last button is Submit.** "Save and Continue" is another step;
  "Back" is never pressed. Getting that wrong either walks the wizard backwards
  or submits early, so anything not clearly final is treated as another step.
- **Screens with no fields** (a Review page) are recognised as gates rather
  than treated as an empty form.
- **Autofill is taken when offered**, because it is the employer's own parser
  reading your own resume, and it is the only practical way past a page like
  Workday's My Experience. It does not weaken the no-fabrication rule: the
  step is re-read afterwards and anything your profile can answer overwrites
  the parsed value, so a mis-parsed phone number does not survive. The whole
  application still goes through review before submission.

`MAX_APPLICATION_STEPS` (default 12) exists to stop a loop, not to limit a
long application.

### What about Google, Amazon, and other in-house systems?

Find Work can read companies that have a configured careers backend, including
Google and Amazon. Discovery and application support are separate: when there
is no dedicated form adapter, the generic adapter drives the application and
stops for review or human input. You can also paste a job URL directly into a run.

## One job, one page

Each feature here grew its own page, which left the thing they all describe —
a single job at a single company — split across five of them. `/jobs/<id>` is
the join: the score and the reasoning behind it, what the application actually
contains (which fields came from your profile, which from remembered answers,
which were written for this employer, which are still waiting on you), the
interview rounds and the questions you were asked, and how it ended.

It takes a lead id or an application id, because the link you have could be
either.

## Making the resume ATS-friendly

Tailoring is two separate model calls, on purpose. The first sorts the job's
keywords into three buckets:

- **covered** — your resume already demonstrates it
- **grounded** — absent from the resume, but the evidence exists in your
  material, and the analysis has to quote it
- **unsupported** — nothing supports it

Only the grounded list is handed to the rewrite step, which is told it may not
introduce anything else. Then the output is **checked**: every unsupported
keyword must be absent unless it was in the original, and anything that slipped
through is reported loudly rather than shipped quietly.

That boundary is the point. "Deployed to AWS ECS" grounds *containers*; it does
not ground *Kubernetes*, and an interviewer will find out. The unsupported list
is a useful result on its own — it tells you exactly what this job wants that
you do not have.

Output is a single-column `.docx` and a plain `.txt`: standard headings, plain
`- ` bullets, no tables, no columns, no headers or footers, no graphics.

---

## Tracking what happened

`status` is how far the automation got. `outcome` is where you stand with the
employer. They are different facts and both are worth keeping.

Per application: which resume and cover letter went out, the outcome, interview
rounds with dates and status, the questions you were asked with your answers and
how you think they went, and what you would do differently.

The `/retro` page is the one that pays for the rest: questions several companies
asked you (prepare those properly) and the mistakes that keep recurring. An
interview answer you liked can be pushed into the answer bank with one tick —
application forms ask the same questions.

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
cp .env.example .env          # DATABASE_URL is the only one you must set here
pnpm setup                    # install, push the schema, download Chromium
pnpm --filter @ja/server seed # optional: a starter profile and standing answers
```

`pnpm setup` runs the browser download as
`pnpm --filter @ja/server exec playwright install chromium`. Use that form
rather than a bare `npx playwright install` — Playwright lives in the server
package, so `npx` fetches a *different* copy from the registry and downloads
browsers for whatever version that happens to be, leaving the one you actually
run still missing its Chromium.

If the download is blocked on your network, set `CHROMIUM_EXECUTABLE_PATH` to a
Chromium you already have and skip it.

Run the two processes:

```bash
pnpm dev:server   # API + run engine on :8787
pnpm dev:web      # UI on :3000
```

Then open <http://localhost:3000>. The front page lists what is left to set
up; **Settings** takes the API keys directly, checks each one against the real
API before saving it, and applies it without a restart. Fill in your profile,
upload your resume, and press **Find jobs for me** — or paste a job URL
directly if you already have one in mind.

Keys are stored in the `settings` table of your own database, in plain text —
the same protection as the `.env` file they replace, no better. A saved key is
never sent back to the browser; the page shows only the first and last four
characters. Anything already in `.env` keeps working and is labelled as coming
from there.

### Which model provider, and what it costs

Two backends. Set one key and go — `LLM_PROVIDER` is inferred from whichever
is present.

**Gemini** — free. Get a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). The free tier
is limited by requests per minute and per day rather than by spend, so a normal
day of applying costs nothing.

> One thing to know before you paste your resume in: on the **free** tier
> Google may use your API data to improve their products, and this app sends
> your resume, your work history and your answers. Enabling billing on the
> Google Cloud project excludes your data from that. If neither suits you, use
> Anthropic.

**Anthropic** — pay-as-you-go from the first token. A Claude.ai Pro or Max
subscription does **not** include API credits; the API is a separate product at
[console.anthropic.com](https://console.anthropic.com).

Either way it is cheaper than you would guess, because most fields never reach
a model: name, contact and links come off your profile, the recurring twenty
questions come from your stated facts, and anything you have answered before
comes from the answer bank. The model is the last resort, not the first.

Work splits into two kinds and gets two model slots:

| Slot | Used for |
|---|---|
| `GEMINI_MODEL` / `ANTHROPIC_MODEL` | Anything producing text you submit: cover letters, essay answers, the resume rewrite, and the grounded-vs-unsupported keyword decision |
| `GEMINI_MODEL_CHEAP` / `ANTHROPIC_MODEL_CHEAP` | High-volume judgement: "is this answerable from the resume?", "does this posting fit?" |

| | Gemini free tier | Opus + Haiku | Sonnet + Haiku |
|---|---|---|---|
| One application | $0 | ~$0.11 | ~$0.07 |
| Tailoring a resume | $0 | ~$0.28 | ~$0.17 |
| **100 applications** | **$0** | **~$11** | **~$7** |

Shown live on the dashboard. Set both slots to the same value to opt out of the
split. The keyword analysis stays on the stronger slot whatever else you
change — it decides what may go on your resume, and that is not the place to
save a cent.

Model ids move, especially on Gemini. `GET /api/models` reports what your key
can actually reach, rather than trusting the defaults in `.env.example`.

---

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
| `ashby` | `jobs.ashbyhq.com` | Application mounts only after Apply and has **no `<form>` wrapper**; Cloudflare fronts some tenants. |
| `workable` | `apply.workable.com` | Drop-zone resume upload over a hidden file input. |
| `generic` | anything else | No site knowledge; labels only. Always routed through review. |

Adding one means implementing five methods in `apps/server/src/ats/types.ts`.
The generic extractor and fill engine do the heavy lifting.

### Getting to the form

Every adapter opens its form through `browser/openForm.ts`, because the naive
route — navigate, wait for `<form>`, fill — is wrong on most modern boards in
three separate ways:

1. **An interstitial may render instead of the page.** Cloudflare's managed
   challenge replaces the document. Waiting for a form during one waits for
   something that does not exist. The flow waits it out (they usually clear
   themselves on a warmed-up profile) and hands you the open browser if it
   does not.
2. **The form usually sits behind an Apply button.** The job URL shows a
   description; the application mounts on click.
3. **`<form>` is the wrong thing to wait for.** Ashby renders bare React
   inputs with no form element at all, so readiness is measured in *visible
   fillable controls*, not tags.

When it still cannot find a form it reports what it actually saw — input
count, whether a form tag exists, which apply controls were on the page, and
the page's opening text — rather than the name of a locator that timed out.

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
  ats/adapters/      Per-board knowledge for driving application forms
  discovery/         Web search, board APIs, careers-page crawler, scoring and learning
  resume/            Keyword analysis, grounded rewrite, ATS docx/txt rendering
  engine/            Resolver, answer bank, run state machine, queue
  llm/               Claude: cover letters, essays, answer inference
  routes/            Discovery, resume and tracker endpoints
  index.ts           Fastify API + SSE
apps/web/            Next.js UI
fixtures/            Offline replicas of real Greenhouse and Lever DOM
```

| Page | What it is for |
|---|---|
| `/discover` | Search for openings, triage the queue, see what the ranking has learned |
| `/jobs/<id>` | One job, everything about it: match and why, the application, interviews, outcome |
| `/settings` | API keys, checked against the real API and applied without a restart |
| `/` | Live run view: log, screenshots, question popup, review gate |
| `/resume` | Tailor for a job; the grounded / unsupported split |
| `/tracker` | Outcomes, rounds, questions, lessons |
| `/retro` | Recurring questions and recurring mistakes |
| `/profile` | Who you are, your resume, your standing answers |
| `/answers` | The answer bank, editable |

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

71 tests, no network and no API key required. They run the real extractor and
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
- **Put a keyword on your resume you cannot back up.** The tailor's allow-list
  is derived from quoted evidence, and the output is checked against it.
- **Re-show a lead you already decided on.** Nothing resurrects a rejection.
