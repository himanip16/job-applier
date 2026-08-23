# Job Applier

Runs a job search end to end: finds the openings, ranks them against what you
actually want, fills in the applications, tailors your resume for each one, and
keeps a record of what happened.

Four parts:

1. **Find work** — searches the web for openings that match your resume, with
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

Press **Find jobs for me**. You do not name any companies.

It reads your resume, your stated preferences and — most usefully — the
postings you have already shortlisted or rejected, turns that into a handful of
web searches, and runs them **restricted to the job boards it can actually
submit an application to**. A posting it cannot apply to is not a lead, it is a
distraction.

Then the part that makes this cheap and accurate. A search result is just a
URL, but `job-boards.greenhouse.io/mercury/jobs/6118243004` says the posting is
Greenhouse board `mercury`, and that is enough to call Greenhouse's own API and
get *every* opening at that company with full descriptions, real locations and
posting dates — free, structured, no parsing. So the flow is:

```
search  ->  recognise the board  ->  hydrate from the board's own API
(paid)      (a regex)                (free, complete, and finds the siblings)
```

One search hit routinely becomes several leads, and each company found is added
to the watch list below, so its *future* postings arrive through the ordinary
crawl without costing another search.

Hydrating a whole board is a gift for coverage and a hazard for a triage queue:
Mercury has 56 openings and a backend engineer wants one of them. So postings
the search actually matched are always kept, and their siblings have to look
like a role the plan asked for — same distinctive words *and* the same kind of
job, which is what stops a search for "payments" surfacing `Counsel, Product &
Regulatory - Payments & AML`.

### Boards it can read

| Source | What it uses |
|---|---|
| `greenhouse` | `boards-api.greenhouse.io` — the board's own public postings API, full descriptions included |
| `lever` | `api.lever.co/v0/postings` |
| `ashby` | `api.ashbyhq.com/posting-api` |
| `workable` | `apply.workable.com/api/v3` |
| `careers-page` | a real crawl of a company's own site — same origin, depth-limited, page-budgeted, rate-limited |

Four of the five are the platforms' own public APIs, published so aggregators
can read them. Structured JSON beats scraping a React page in every respect
that matters here.

Not every board answers: some Greenhouse boards 404 on the public API even
though the posting is live. When that happens the posting search found is kept
anyway, with the shorter description, and the run says so.

Every posting gets a free lexical score; only the top slice gets read in full by
a model. A 400-job crawl therefore costs a handful of model calls, not 400.

### What search costs

Searching needs a [Firecrawl](https://firecrawl.dev) key — paste it on the
Settings page, or set `FIRECRAWL_API_KEY`. The free tier is enough for a
personal job hunt. A run is about two credits
per query and six queries by default, so roughly a dozen credits; everything
after the search is done by the boards' own free APIs.

Without the key the rest of the app is unaffected: add companies by hand and
crawl those, or paste a job URL straight into a run.

Your queries are derived from your resume and sent to Firecrawl, which passes
them to a web search provider. The resume itself is not sent.

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

They work the same way, with one caveat. Only Greenhouse, Lever, Ashby and
Workable publish board APIs, so **Find jobs for me** only searches those — an
in-house careers site will not turn up there. You can still paste the URL into
a run and the generic adapter drives it.

Google Careers is the honest example. Its Apply link redirects to
`accounts.google.com`, whose first screen asks for an email address and nothing
else — no password field, no "sign in to apply" text. That is why login
detection also matches known identity-provider hosts. You sign in once, press
**Done — carry on**, and the wizard continues.

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
