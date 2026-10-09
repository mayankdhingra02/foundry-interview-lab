# Foundry Interview Lab

Practice engineering interviews through realistic coding exercises, adaptive discussion, and evidence-based coaching.

Foundry Interview Lab is an interview preparation product within Engineering Foundry. It focuses on working with unfamiliar repositories, debugging, extending code, using permitted AI assistance, and explaining engineering decisions.

## Current status

This repository contains the product roadmap and technical design. Application implementation has not started in this repository. Engineering Foundry's existing application and local Interview Lab prototype are separate integration inputs described in the design.

## Documentation

- [Product roadmap and technical design](docs/design.md) — canonical, version-controlled planning document.
- [Formatted Word document](docs/Engineering_Foundry_AI_Interview_Practice_Design.docx) — downloadable edition of the initial design.
- [System architecture](docs/assets/architecture.png).
- [Session lifecycle and stages](docs/assets/states.png).
- [First ten working days](docs/design.md#23-first-ten-working-days).
- [Open decisions and dependencies](docs/design.md#26-decisions-and-dependencies-still-open).

The design distinguishes source behavior observed on October 9, 2026 from proposed capabilities and work that still requires qualification. Timelines, budgets, and release thresholds are planning estimates.

## Proposed first release

- Original Python repository exercises with reviewed tasks, tests, and rubrics.
- A bounded coding workspace with saved files, test execution, and edit previews.
- Separate AI interviewer, coding assistant, and post-interview coach roles.
- Adaptive text discussion grounded in the learner's actual code and answers.
- Feedback linked to code snapshots, test results, and transcript evidence.
- Saved attempts, resume and recovery, usage limits, and deletion.
- Optional voice after the text workflow meets its quality and reliability gates.

Finish coding freezes the code for discussion. Final submit freezes the complete evidence set and starts coaching report generation.

## Delivery roadmap

| Phase | Proposed cumulative timing | Outcome |
| --- | --- | --- |
| Adaptive text alpha | 2–3 weeks | One reviewed exercise with grounded debrief and feedback |
| Hosted beta | 8–12 weeks | Accounts, persistence, isolated execution, recovery, quotas, and 3–5 exercises |
| Expanded paid release | 3–5 months | Qualified operations, payments, targeted practice progression, and selective expansion |

These estimates assume two engineers, an experienced technical interviewer or content author, shared design support, and reuse of suitable Engineering Foundry infrastructure. The detailed design defines dependencies and acceptance gates.

## Build and buy boundary

Foundry owns the scenarios, competency model, rubrics, interview controller, evidence contracts, feedback validation, and learning progression. Managed services provide language-model inference, speech, media transport, isolated compute, and payment processing where appropriate.

The first release does not require training a foundation model, speech model, or proprietary scoring model. Provider choices remain subject to workload benchmarks, account access, and operational qualification.

When implementation begins, establish the integration base, resolve the open decisions, and follow the first ten working days in the design. Keep credentials and learner data outside Git.
