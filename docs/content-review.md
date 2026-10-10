# Content package review

The initial catalog contains five distinct Python preparation tasks. Each package has a disclosed contract, editable starter files, one complete reference, public and protected contract checks, four interview stages, three anchored rubric criteria, three graduated hints, three debrief probes, three focused drills covering every criterion, misconception notes, an explanation, and provenance. Protected checks add coverage of the disclosed requirements; they do not introduce surprise requirements.

The owner has made the source repository public. Authored references, protected checks, hints, probes and explanations in these packages and the three [level drafts](curriculum.md) are publicly readable. Application responses still omit protected author material; this is not source confidentiality or proof of a fresh/unseen task. Review distribution rights for already-public assets as well as every admitted immutable version. Private attempts on public tasks can support feedback evaluation, while confidential holdout families and fresh-task transfer material need separate custody, independent review and recorded exposure. See [the public-source boundary](ci.md#public-repository-and-actions-scope).

| Package | Main capability | Automated reference checks | Expected starter gap |
| --- | --- | --- | --- |
| monetary-validation | Integer monetary arithmetic, half-up rounding, exact validation | 9 passing | Half-cent rounding and invalid quantities |
| extension-compatibility | Extend an API while retaining byte-level CSV behavior | 7 passing | Ignored filter and missing JSONL |
| duplicate-invoice | Durable scoped retry identity and conflicting payloads | 6 passing | A repeated delivery creates another invoice |
| inventory-reservations | Atomic database updates across independent connections | 6 passing | Invalid quantities and stale read/write overselling |
| event-rollup | Understand and repair a multi-module data pipeline | 7 passing | Local-day grouping, refund sign, duplicate events |

Automated validation on October 9, 2026 ran the 35 reference checks successfully on Python 3.10.13 and Python 3.11.12 and confirmed that every starter fails its intended contract checks. The inventory starter admitted 16 one-unit reservations against five units in the observed concurrent run; the reference admitted exactly five and persisted zero remaining units. This is an observed test result, not proof that all concurrency schedules have been explored. The application harness and hosted runtime must also be qualified separately.

Run `npm test -- tests/content.test.ts` for schema/cross-reference, public-transport isolation, immutable lookup, reference execution, and starter divergence checks. A Python interpreter is required; use `FOUNDRY_PYTHON_BIN` to select it. The shipped runtime profile is Python 3.11, and local Python 3.11.12 validation passed. Qualification in the pinned Python 3.11 container remains an explicit follow-up until that integration check is recorded.

## Package structure

Each directory under `content/scenarios/` contains `manifest.json`, `starter/`, `reference/`, `tests/`, `explanation.md`, `author-notes.md`, and `provenance.md`. Manifests reference package-local files; the server-only loader validates metadata, cross-references, and relative asset paths, then hydrates the shared `Scenario` contract. `listScenarioSummaries` is safe catalog metadata. Use `toPublicScenario` before transporting a full scenario to the browser. That conversion removes reference files, protected sources, authored probes, and unrevealed hints.

The catalog loader returns copies so workspace changes cannot mutate a shared task package. Sessions pin `id` and `version`. Published task changes must increment the package version; existing attempts must retain their admitted package. There are currently no separately calibrated unseen variants. Repeating a known package must be marked repeated; a new attempt alone does not make it fresh.

## Human review remains open

These tasks are implementation-complete drafts with automated checks. They are not expert-calibrated or learner-validated assessments. Before a public catalog release:

- Have an experienced independent engineer review every requirement, reference, deliberately flawed approach, hidden check, hint, probe, and explanation.
- Verify alternative valid solutions, not just the supplied reference. Add at least one contrasting correct solution for each concurrency or serialization task.
- Adjudicate whether rubric anchors distinguish observed behavior without rewarding verbosity, style preference, or use of a particular implementation.
- Build the design document's separate 40–60 example feedback benchmark; the 35 code checks here are not that benchmark.
- Trial difficulty, timing, hint usefulness, prompt relevance, and fresh-task transfer with the planned learner pilot. Do not claim hiring-score validity or demonstrated learning improvement.
- Review accessibility, rights/provenance, and transcript/feedback quality with the product owner.
- Validate resource limits and cleanup in the pinned hosted Python runtime. These test files share a process with learner code and are coaching checks, not tamper-resistant grading.

All expert reviews, rubric calibration, and learner trials remain pending. No learner data or third-party proprietary interview questions were used to create the catalog. The duplicate invoice package reuses selected task-only assets from Foundry's original local mission; the other four scenarios are original project content.
