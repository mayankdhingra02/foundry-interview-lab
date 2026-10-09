# Learner-authored regression checks

Learners may add one optional workspace file, `learner_checks.py`, with Python `unittest.TestCase` checks. It is limited to 8,000 UTF-8 bytes, the workspace remains capped at 256 KB, and arbitrary new filenames, commands, dependencies and network access are not accepted. The slot is an additive workspace policy (version 1), not a change to an authored scenario package. Existing scenario content/digests, initial files, snapshots, queued jobs and frozen reports are not rewritten or automatically supplemented. An authored package already using the reserved slot/ID keeps its original meaning and cannot opt into the conflicting learner-check policy.

Check editing uses the ordinary full-workspace `PUT /api/interview-practice/sessions/:id/workspace`, with owner, `expectedRevision` and `requestId` validation. Its source is stored as part of the same immutable file snapshot as the implementation and included in the existing SHA-256 snapshot digest. Autosave, acknowledged recovery, export, deletion and capacity limits therefore cover the check without a second mutable source store. Finish coding freezes that source with the rest of the code; editing afterward requires a new attempt.

## Separate execution selection

`POST /api/interview-practice/sessions/:id/runs` accepts `{requestId, expectedRevision, selection?: "authored" | "learner"}`. Absent or explicit `authored` preserves the original request fingerprint and runs the unchanged authored suite, including its protected contracts in the worker. A learner slot never replaces or extends those contracts. `learner` explicitly runs only the saved learner slot as the fixed `learner-regression-v1` suite. Unknown selections and attempts to provide test source, policy, IDs or runner commands in the run request are rejected.

The admitted learner job freezes its selection, workspace/execution policy versions, source path and SHA-256, selected suite digest, code snapshot ID/hash and immutable runtime binding. Worker execution validates those against the original private scenario and admitted snapshot before calling the existing isolated runner. Later edits or runtime environment changes do not redirect an admitted job. Completion derives learner provenance from the immutable input rather than accepting a worker-supplied label. An unsupported policy, unknown check ID, changed source/suite, mismatched runtime, missing completed learner observation or stale worker fails closed.

The learner suite has a fixed three-second check timeout within the existing scenario's total execution budget. It uses the same nonroot, read-only, network-free container path, output limit, CPU/memory/process limits, cancellation, cleanup hold, lease and fencing behavior as authored checks. Both selections consume the existing run quota; there is no extra unlimited execution allowance. No code runs on the application host, no runtime is pulled on request, and no model/billing call is required.

Example (adapt imports and behavior to the chosen repository):

```python
import unittest
from quote import quote_total

class MyRegressionChecks(unittest.TestCase):
    def test_empty_quote(self):
        self.assertEqual(quote_total([]), 0)
```

The harness counts actually discovered unittest cases. A source file that only prints a success message, defines no discovered tests, or exits without validated evidence cannot pass. Zero discovered cases become an explicit error, even with exit code zero; timeout/cancellation produces missing/skipped observations rather than a skill judgment. A passing trivial/self-confirming learner check is only evidence of that submitted check, not independent correctness or strong test quality.

## Evidence and reports

Run results label learner checks separately. Their frozen test evidence uses source `learner-authored-check`, with distinct suite digest, workspace/execution policy versions, source SHA/path, runtime digest and code snapshot identity. Original check source is available in the owned code snapshot and export; protected authored source and reference solutions never enter public run DTOs. Legacy authored observations retain their existing representation.

The deterministic coaching guard rejects universal authored/protected success claims based only on learner checks and validates same-snapshot executed statuses. Unqualified “all tests passed” needs the full authored suite and, if recorded, the separate learner suite; explicitly qualified learner claims cannot imply protected outcomes. The model boundary also identifies learner check evidence as untrusted work. These limited factual guards and source bindings do not prove all natural-language claims true, validate coverage or make this shared-process coaching harness tamper-resistant grading. Human evaluation must still assess whether a regression check detects a meaningful bug, tests the intended contract and supports the coaching interpretation.

## Validation scope

Deterministic tests cover byte/path bounds, snapshot binding/replay, suite selection, forged provenance, evidence claims, fencing and original package preservation. FileStore tests save/reload actual temporary files. Fake-Docker tests verify payload/result contracts without Python execution. Three new real-container cases exercise learner/protected separation, zero discovery and timeout cleanup; one real PostgreSQL case covers immutable admission, roundtrip/source binding, owner RLS and deletion. These passed in PR #57's isolated job and again in all-green [run 38004051618](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/38004051618), commit `1a13950`: 17 real Docker cases and 63 SQL cases in total. They were not run locally. PR #57's separate registry provisioning failure remains recorded; performance/security and hosted release gates retain their original scope.

This adds no catalog package, difficulty level, expert annotation or holdout label. Difficulty variants, expert review, model calibration, adversarial evaluation and learning-outcome gates retain their original status. Passing developer contracts is not a substitute for those gates.
