# Foundry Interview Lab

Practice engineering interviews through realistic coding exercises, adaptive discussion, and evidence-based coaching.

Foundry Interview Lab is an interview preparation product within Engineering Foundry. It focuses on working with unfamiliar repositories, debugging, extending code, using permitted AI assistance, and explaining engineering decisions.

## Current status

The core practice workflow and follow-up fixes are merged into `main` through PR #70 at the owner's request. See [the focused PR history](https://github.com/mayankdhingra02/foundry-interview-lab/pulls?q=is%3Apr+is%3Amerged), [delivery status](docs/delivery-status.md) for recorded checks, and [the design acceptance audit](docs/design-acceptance.md) for remaining qualification work. The application has not been publicly deployed.

The source repository is public at the owner's request. Its standard GitHub-hosted CI runners receive free public-repository minutes. Authored solutions, protected checks and development fixtures are public preparation material; “protected” describes omission from ordinary application responses. Private attempts and actual acceptance/holdout artifacts belong outside Git. See [CI and public-source boundaries](docs/ci.md#public-repository-and-actions-scope).

## Documentation

- [Delivery status and release gates](docs/delivery-status.md).
- [Design acceptance audit and remaining engineering](docs/design-acceptance.md).
- [Pull request history and original dependencies](docs/pr-stack.md).
- [Product roadmap and technical design](docs/design.md) — canonical, version-controlled planning document.
- [Formatted Word document](docs/Engineering_Foundry_AI_Interview_Practice_Design.docx) — downloadable edition of the initial design.
- [System architecture](docs/assets/architecture.png).
- [Session lifecycle and stages](docs/assets/states.png).
- [First ten working days](docs/design.md#23-first-ten-working-days).
- [Open decisions and dependencies](docs/design.md#26-decisions-and-dependencies-still-open).

The design distinguishes source behavior observed on October 9, 2026 from proposed capabilities and work that still requires qualification. Timelines, budgets, and release thresholds are planning estimates.

## Implemented practice workflow

- Five preserved Python benchmark exercises plus three distinct level drafts with prerequisites, public/protected checks, rubrics, hints, probes and drills; calibration/content approval remain pending.
- A bounded coding workspace with saved files, separate learner/authored check runs, edit previews and safe undo that preserves assistance history.
- Separate AI interviewer, coding assistant, and post-interview coach roles.
- Adaptive text discussion grounded in the learner's actual code and answers.
- Feedback linked to code snapshots, test results, and transcript evidence.
- Saved attempts, resume and recovery, export/deletion, spending limits, provisional progression, and bounded study plans.
- Permissioned support requests and independently reviewed report corrections that preserve original evidence.
- Typed advisory timing/written-participation choices, explicit extensions and optional press-to-talk speech/payments behind qualification gates.
- Default-off bounded telemetry, opaque operational support references and explicit failed-sign-in recovery.
- Private corpus/capture preparation, separately bound model recording and blind human-review tooling; real acceptance data and independent judgments remain pending.

Finish coding freezes the code for discussion. Final submit freezes the complete evidence set and starts coaching report generation.

Production starts closed to new attempts by default. Code and deterministic checks do not establish content approval, feedback quality, security qualification, or learning effectiveness.

## Run locally

Use Node 24 and Python 3.11. Check out `main`, then:

```sh
npm ci
cp .env.example .env.local
chmod 600 .env.local
node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const p=".env.local";fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^SESSION_SECRET=.*$/m,"SESSION_SECRET="+crypto.randomBytes(32).toString("hex")),{mode:384})'
npm run dev
```

Open `http://127.0.0.1:3000`. Local identity uses a signed development cookie and file storage; it is disabled in production. Keep private attempts, exports and credentials outside Git. No model key is needed to explore the text workflow. Reports disclose when no assessment was produced.

For real execution, provision the reviewed Python image and set its exact `PYTHON_IMAGE_ID` before practice with a healthy Docker installation. Learner code runs inside constrained containers using cached images. Hosted deployments must place the worker and Docker daemon on a dedicated execution host; the adapter alone does not enforce physical host separation. See [execution](docs/execution.md). A configured adapter is not a successful run.

`npm run worker` starts the durable worker using the same environment. Hosted operation requires verified Supabase identity, ordered PostgreSQL migrations, separate web/worker configuration, and the checks in [deployment](deploy/README.md) and [operations](docs/operations.md).

## Verify changes

```sh
npm run check
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npm run test:e2e
```

Start the development server separately for browser tests. Playwright uses installed Google Chrome by default; [development setup](docs/development.md) describes the Chromium alternative. Default tests exclude explicitly enabled container/database integrations. [CI](docs/ci.md) also requires real isolated execution, PostgreSQL owner/transaction checks, bounded load and restore checks, browser recovery, deployment image builds, and container startup. Review the exact commit's results; an earlier passing run does not qualify later changes.

Implementation details and release limitations are documented in [AI](docs/ai.md), [API](docs/api.md), [content review](docs/content-review.md), [persistence](docs/persistence.md), [quota accounting](docs/quotas.md), [retention](docs/retention.md), [speech](docs/voice.md), [billing](docs/billing.md), [support/corrections](docs/review.md), [progression](docs/progression.md), [rollout](docs/rollout.md), and [evaluation](docs/evaluation.md), [curriculum](docs/curriculum.md), [learner checks](docs/learner-checks.md), [measurement](docs/measurement.md), [private model review](docs/private-model-evaluation.md), and [dependency assessment](docs/dependency-audit.md).

## Original planning estimates

| Phase | Proposed cumulative timing | Outcome |
| --- | --- | --- |
| Adaptive text alpha | 2–3 weeks | One reviewed exercise with grounded debrief and feedback |
| Hosted beta | 8–12 weeks | Accounts, persistence, isolated execution, recovery, quotas, and 3–5 exercises |
| Expanded paid release | 3–5 months | Qualified operations, payments, targeted practice progression, and selective expansion |

These estimates assume two engineers, an experienced technical interviewer or content author, shared design support, and reuse of suitable Engineering Foundry infrastructure. The detailed design defines dependencies and acceptance gates.

## Build and buy boundary

Foundry owns the scenarios, competency model, rubrics, interview controller, evidence contracts, feedback validation, and learning progression. Managed services provide language-model inference, speech, media transport, isolated compute, and payment processing where appropriate.

The first release does not require training a foundation model, speech model, or proprietary scoring model. Provider choices remain subject to workload benchmarks, account access, and operational qualification.

The design remains the planning baseline; delivery status records what is implemented and what still needs external qualification. Keep credentials and learner data outside Git.
