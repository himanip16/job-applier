# Can you apply to any role at any company with one button?

Short answer: **no, and anyone who tells you otherwise is selling something.**
But the honest version of it — one button that does 95% of the work and stops
at the places a human is genuinely required — is very achievable, and that is
what this repository builds.

Here is the reasoning, with the evidence.

---

## What actually blocks full autonomy

### 1. CAPTCHA is on the standard forms, by design

This is the whole ballgame, so it goes first. In August 2026 I read the live
markup of a Greenhouse job board and a Lever application form. Both ship a
challenge on the standard application form:

| Board | Evidence in the page |
|---|---|
| Greenhouse (`job-boards.greenhouse.io`) | `<textarea name="g-recaptcha-response">`, plus 28 references to reCAPTCHA in the page source |
| Lever (`jobs.lever.co/…/apply`) | both `g-recaptcha-response` and `h-captcha-response` textareas; 55 references to hCaptcha |

A CAPTCHA is not an engineering obstacle to route around. It is the site
stating, in the clearest terms available to it, *"a human must be present for
this action."* Automating past it means either a solver farm or a fingerprint
evasion arms race. Both are unambiguous violations of these sites' terms, both
put your real name and email on the other end of the request, and both break
the moment the vendor ships a new challenge.

So the design constraint is fixed: **something has to happen at a keyboard.**

The good news is how little. reCAPTCHA and hCaptcha mostly run in *invisible*
mode, scoring the session rather than showing a puzzle. A long-lived browser
profile with genuine history and human-paced interaction frequently passes with
no challenge shown at all. When a challenge does appear, this system stops with
the form already filled and hands you a browser window: you tick a box and
press approve. Five seconds, versus the five minutes of typing you skipped.

Not every tenant enables it, either — CAPTCHA is per-company configuration on
both platforms — so a meaningful share of applications go through untouched.

### 2. There is no candidate-side API

Greenhouse publishes a Job Board API with a `POST /applications` endpoint, and
it is genuinely tempting. It is also unusable here: it authenticates with the
*employer's* board token. As a candidate you have no credential for it. Same
story elsewhere. Driving the real form in a real browser is the only route in
from this side, which means the automation is only ever as stable as the DOM.

### 3. Some ATSes want an account before they want your application

Workday and Taleo, in particular, front the application with account creation
and email verification. That is a per-tenant signup and a code in your inbox —
not something to automate, and not something you want automated, since it is
creating a real account in your name. This system detects it and hands over.

### 4. The tail is very long

Roughly 60–70% of postings run on a handful of platforms. The rest are bespoke
career pages, regional ATSes, and WordPress forms. A generic label-driven
fallback handles many of them, but at materially lower reliability — so those
always route through review.

### 5. LinkedIn Easy Apply and Indeed are out

Their terms prohibit automated interaction, and they enforce it aggressively
with account-level consequences. Getting your LinkedIn account restricted while
job hunting is a spectacular own goal. This repository does not touch them.

---

## What that leaves — which is a lot

| Stage | Automated? |
|---|---|
| Detect the ATS and open the real application form | Yes |
| Read the job title, company and description | Yes |
| Read every field, its type, and its options — including dropdowns whose options do not exist in the DOM until opened | Yes |
| Fill name, contact, location, links | Yes, from your profile, no model involved |
| Answer the recurring twenty questions (work authorization, sponsorship, notice period, salary, years of experience…) | Yes, from your stated facts |
| Answer a question you have answered before, at a different company, worded differently | Yes, from the answer bank |
| Answer a question derivable from your resume | Yes, with a confidence gate |
| Write a cover letter grounded in your resume and the job description | Yes |
| Write "why do you want to work here", per company, never recycled | Yes |
| Attach your resume, including through drag-and-drop widgets over hidden file inputs | Yes |
| Demographic / EEO questions | Deliberately not. Defaults to the form's own "decline to self-identify" |
| Anything genuinely unknown | **Stops and asks you. Remembers the answer forever.** |
| CAPTCHA, login, email verification, assessments | Stops and hands you the filled form |
| Press submit | Yes, after you approve (or unattended once you turn review off) |

The realistic shape of it: **the first application asks you five or six
questions. The tenth asks you none.** That is the product.

---

## Why "ask rather than guess" is the load-bearing decision

The tempting shortcut is to let the model fill in whatever it does not know.
It will produce fluent, plausible answers to "what is your notice period?" and
"how many years of Kubernetes do you have?" — and they will be invented.

That is not a small problem. These forms are submitted under your name, and
several of them are legal declarations: work authorization, visa status,
criminal history, non-compete obligations. A fabricated answer is
misrepresentation on a job application. It can cost you the offer after you
have accepted it.

So the resolver is built around a refusal. The model is instructed that
handing a question back is *the correct outcome* whenever the answer is not in
your profile or resume, and every branch of the code treats "not answerable" or
"not confident enough" as a hard stop rather than a nudge toward a guess. Then
— and this is what makes it bearable — the answer you give is stored and reused
forever, matched by meaning rather than exact wording, so you are never asked
twice.

---

## Why TypeScript

- **Playwright's Node binding is the reference implementation.** Everything
  hard here is browser automation: portalled listboxes, hidden file inputs,
  frames, CDP. The Node API gets features first and has the deepest
  documentation.
- **One language across the whole path.** The field schema produced by the
  extractor is consumed by the resolver, persisted by the API, and rendered in
  the question popup. Those are the same Zod types end to end — and since the
  schema *is* the product here, that matters more than usual.
- **The interactive pause needs real-time plumbing.** A run that parks waiting
  for you needs SSE from worker to browser. Trivial in this stack.
- **Python's usual advantage does not apply.** The heavy lifting is DOM driving
  and one hosted model API, not numerics. And with the answer bank matched
  lexically over a few hundred rows, there is no vector database to reach for.

Postgres holds state; there is no Redis, because a job that blocks for an hour
waiting for a human is a bad fit for a visibility-timeout queue.

---

## What could still go wrong

Worth saying plainly:

- **DOM changes break adapters.** Greenhouse ships React changes without
  notice. The generic label-driven fallback limits the blast radius, and the
  fill engine verifies every value it sets by reading it back, but expect to
  fix selectors occasionally.
- **Terms of service.** Automated submission is a grey area on most boards and
  explicitly prohibited on a few. This system acts on your own behalf with your
  own data, which is closer to a password manager's autofill than to scraping —
  but it is your account and your name on it.
- **Volume is not the goal.** Spraying 200 generic applications is worse than
  sending 20 considered ones, and recruiters notice. There is a hard cap on
  submissions per hour in the config, deliberately.
- **Confirmation is not always visible.** The submit detector requires positive
  evidence and reports `NEEDS_HUMAN` when it cannot find any, rather than
  claiming a success it did not see.
