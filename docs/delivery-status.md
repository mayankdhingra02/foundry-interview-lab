# Delivery status

The target remains the full product and release requirements in [the design](design.md). Work is split into focused pull requests. A checked code path does not establish live-provider reliability, expert content approval, or learning effectiveness.

## Implementation workstreams

| Workstream | Required outcomes | Current state |
| --- | --- | --- |
| Application foundation | Next runtime, typed tooling, private identity boundary, request validation, CI | In progress |
| Session engine | Immutable scenarios and snapshots, independent stage/lifecycle, owner access, CAS, idempotency, evidence, jobs, fencing, spend reservation, recovery, deletion | In progress |
| Authored content | Five distinct Python tasks, public/protected checks, reference solutions, rubric anchors, hints/probes, drills, provenance | Drafted; automated reference validation, expert approval pending |
| AI orchestration | Separate interviewer/assistant/coach contexts, structured outputs, evidence/action validation, bounded repair/fallback, version and usage capture | Pending |
| Execution | Snapshot runner, limits, cancellation and cleanup, no product credentials or public egress, tampering limitations | Pending |
| Learner workspace | Catalog/setup, editor/diffs/tests, dialogue, safe edit acceptance, debrief/report, recovery and accessibility | In progress |
| Durable hosted persistence | PostgreSQL adapter, normalized owner constraints, RLS tests, backup/restore and account lifecycle | Pending |
| Accounts and commerce | Verified accounts, sign-in/out, private export/delete, webhook-verified entitlements, ledger and quotas | Pending |
| Voice | Equipment check, transcript correction, playback interruption, disconnect recovery, text parity, qualified gateway | Pending |
| Progression | Evidence counts, familiarity/help conditions, drills, fresh-task recommendations, provisional profiles | Pending |
| Internal tools | Author preview, permissioned approved evaluation examples, failures/disputes, safe regeneration/support references | Pending |
| Operations | Deployments, migrations, flags, health/traces, provider limits, incident runbooks, load and recovery checks | Pending |
| Evaluation | Curated benchmark, adversarial cases, expert annotations, claim support and question relevance checks | Pending |
| Expansion | System design, behavioral, second language, mentor/peer review, permissioned sharing and study plans | Pending |

## External release evidence

These requirements cannot be satisfied by generating code or synthetic labels. They remain open until the described evidence is obtained.

- Two experienced reviewers independently annotate and adjudicate benchmark attempts.
- The original scenarios receive technical/content rights approval and trial-session review.
- A real learner pilot evaluates usefulness, completion, recovery, and performance on fresh tasks.
- Live model, speech, sandbox, identity and payment access, region, retention and billing behavior are qualified for the deployment account.
- Independent sandbox/security and keyboard/screen-reader reviews close critical findings.
- Production backup restore, deletion cleanup, monitoring and traffic-envelope checks pass on the selected deployment.

## Pull request policy

Keep application foundation, domain engine, content, AI/execution, learner UI and integrations independently reviewable. Stacked PRs identify their dependency and base branch. Never claim the overall product complete from an individual PR's checks.
