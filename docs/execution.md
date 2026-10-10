# Isolated snapshot execution

The application sends an acknowledged immutable workspace snapshot and server-selected contract checks to an isolated Docker container. Learner code is never executed by the web application or worker's host Python interpreter. Every selected test file gets a fresh container and Python process. This isolates imports, database fixtures, and accidental test state between suites.

`executeScenario(scenario, files, { signal, includeProtected, runtimeBinding })` returns the shared `RunExecution` contract. Public checks run by default; the trusted worker selects protected checks for an admitted practice run. Observation IDs are the server's `Scenario.tests.id` values. The result records the inspected immutable local image ID, bounded stdout/stderr, process outcome, per-suite observations, and elapsed time. Callers must attach the admitted snapshot and suite digests to the persisted `TestRun`; the runner does not choose or mutate a session's snapshot.

## Runtime controls

- Server image allowlist, with `python:3.11-slim` as the default authored profile. Both the authored alias and `PYTHON_IMAGE` must be approved in comma-separated `RUNNER_ALLOWED_IMAGES`. An explicit reviewed `PYTHON_IMAGE_ID` is required locally and in production. The ID is frozen when the run is requested, inspected by exact ID, and used for execution. No implicit pull or later alias substitution occurs.
- `--network=none`, no published ports, no host mounts, and no Docker socket inside the container.
- Read-only root filesystem, unprivileged UID/GID 65534, dropped capabilities, no privilege escalation, and Docker's default confinement.
- Maximum 256 MiB memory, equal memory-plus-swap limit, one CPU, 64 processes/threads, bounded open files, 16 MiB regular-file size limit, and a 32 MiB nonexecutable/nosuid/nodev temporary filesystem.
- Product environment variables and credentials are never forwarded. The Docker CLI receives only the small host configuration set needed to reach the daemon.
- Snapshot files and a single selected server check travel as encoded JSON over stdin. No shell interpolation, bind mount, package download, reference solution, hint, or rubric is passed into execution.
- Total scenario and individual suite deadlines are bounded to at most 60 seconds. Captured output is capped at 64 KB and diagnostic detail at 4 KB. Runaway output terminates execution.
- Containers carry `foundry.interview-execution=true`. Cleanup runs independently of caller cancellation, including timeouts, aborted streams, output limits, failed creation/start, and normal completion. Failed cleanup produces an infrastructure error and requires stopping admission and reconciliation.

The worker must abort the supplied `AbortSignal` when cancellation or lease loss is observed. Destroying the Docker CLI process alone is insufficient; the runner forcibly removes the named container before returning. Three bounded cleanup attempts are made. Unconfirmed cleanup latches this worker's admission closed; `runnerHealth()` reports configuration, admission, and the block reason. An operator can call `resetRunnerAdmission()` only after reconciling abandoned containers; no learner reset endpoint exists. The latch is process-local and clears on process restart. A process crash, machine failure, or unavailable daemon can still prevent confirmation; production needs shared admission state and a reconciliation worker that removes abandoned labeled containers and alerts on failure. Do not consider an unconfirmed cleanup a successful execution.

## Results and integrity limits

The harness discovers unittest checks, aggregates each server-selected test file, and emits one nonce-bound JSON result. The host validates the nonce, expected suite ID, counts, status, and exit-code consistency. An early process exit, missing marker, malformed output, zero discovered checks, or contradictory success becomes an error observation. Exit code zero or a printed “passed” string alone never establishes correctness.

The nonce protects against incidental output collisions. Learner code and tests still share a Python process. Deliberately hostile code can inspect or tamper with that process, including harness state; chmod on snapshot files is an accidental-write guard, not a separate trust boundary. These are educational coaching checks, not tamper-resistant grading. Stronger integrity needs an external observable input/output comparison or another trusted evaluation boundary, especially for shared-process SQLite scenarios.

Top-level `timeout` and `infrastructure_error` outcomes must remain separate from skill ratings. Earlier completed suite observations are retained, and uncompleted suites are marked skipped with a technical reason. A retained passing suite does not convert a technical failure into global success. A code assertion or import error can produce a completed run with a failed/error observation; it should be interpreted against the actual evidence and help policy.

## Setup and verification

Install Docker and deliberately provision the reviewed Python image before enabling execution. Image provisioning is an operator action; the runner will not pull on learner requests. Inspect the cached image and configure its actual local `PYTHON_IMAGE_ID` for both web and worker before starting them. See [immutable runtime admission](runtime-binding.md) for the exact contract, migration behavior and test boundary. Use a reviewed registry digest when provisioning, rehearse changes in staging, and retain old admitted image IDs until their jobs finish. A dedicated worker host is required; serverless page handlers should enqueue jobs rather than depend on a Docker socket being available.

Run `npm test -- tests/runner.test.ts` for mocked command construction, source serialization, result validation, output limits, per-suite isolation, cancellation, timeout, and cleanup failure checks. The tests do not run learner code on the host.

Set `FOUNDRY_DOCKER_INTEGRATION=1` when explicitly running the integration suite against a qualified local Docker daemon and cached approved image, with its actual inspected `PYTHON_IMAGE_ID` exported before Vitest starts. This executes all five references and starters inside Python 3.11 containers and exercises isolation, runaway output, timeout cleanup including child processes, and cancellation cleanup. Passing tests do not replace a public-host isolation/security review or operational load test.

Local qualification on October 9, 2026 used Docker 29.4.0 and the already cached `python:3.11-slim` image ID `sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e`. No image was pulled. All five reference solutions passed every public and protected suite; each starter failed an intended check. The isolation probe confirmed UID 65534, no host-only test secret, no host home path, a nonwritable root, and failed external network access. Timeout, cancellation, and runaway-output checks confirmed that no execution containers remained. Record new qualification evidence whenever the approved image or runner changes.

## Remote execution

The legacy remote source-submission adapter is intentionally unavailable in this implementation. Its 50,000-character source limit and execution windows do not establish repository compatibility, cancellation, destruction, or trustworthy result provenance. A future remote adapter must provide a reviewed authenticated HTTPS protocol, bounded request and response sizes, fixed runtime/resource profiles, durable job identity, cancellation/cleanup acknowledgement, usage accounting, and the same integration checks before `RUNNER_MODE=remote` is enabled. There is no fallback to host Python.
