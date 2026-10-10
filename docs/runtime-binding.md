# Immutable runtime admission

Every newly requested code run requires a reviewed, locally provisioned Python image ID. This applies to local development and production. There is no unbound alias fallback. Saving work, reading history, and requesting other available features do not require a code-execution pin.

## Operator setup

Provision and review the approved image outside learner requests. Obtain its local Docker image ID before starting the web application and worker:

```sh
docker image inspect --format '{{.Id}}' python:3.11-slim
```

Set `PYTHON_IMAGE_ID` to that exact `sha256:` value with 64 lowercase hexadecimal characters in the untracked environment file used by both processes. Keep `PYTHON_IMAGE=python:3.11-slim` and `RUNNER_ALLOWED_IMAGES=python:3.11-slim` for the authored default profile. If a reviewed alternate alias is used, both the scenario's authored image alias and the operator's selected alias must appear in `RUNNER_ALLOWED_IMAGES`. An image ID is operator configuration; clients cannot select it through the API. Do not copy synthetic IDs from unit tests.

The local image ID is distinct from a registry manifest digest. CI provisions the reviewed digest-pinned mirror image, inspects the resulting local ID, and exports that ID before starting tests, browser servers, or container startup smoke checks. No learner request pulls an image or invokes Docker while holding a session transaction. See `.github/workflows/check.yml` for this explicit qualification setup.

Missing or malformed configuration disables the runner capability and prevents new run admission with a saved-work message. Readiness also verifies that the exact configured ID is cached and inspectable on the worker daemon. Configuration alone does not establish that Docker is available, the runtime is safe, or the deployment is qualified.

## Frozen contract

`lib/runtime/binding.ts` resolves a pure, synchronous configuration binding:

```ts
type RuntimeBinding = {
  version: 1;
  scenarioImage: string;
  imageAlias: string;
  imageId: string;
};
```

`SessionService.requestRun` stores it in the private job input alongside the authored runtime policy and test-suite digest. The job fingerprint includes that input. The existing owner, revision, request replay and quota transaction covers this admission. Exact replay returns the original result without consulting changed image configuration. Lease takeover preserves the original input and binding. The normalized PostgreSQL adapter rejects changes to a retained job's identity, selected snapshot, fingerprint, or input; whole-attempt deletion still removes private job state.

Before external work, the worker checks the admitted package, snapshot, job input fingerprint, runtime policy, and suite digest. It passes the frozen binding to the Docker adapter. The adapter inspects the exact image ID, requires the inspected ID to match, then creates containers with that ID and `--pull=never`. Changing an alias or `PYTHON_IMAGE_ID` after admission does not substitute another image. Keep previously admitted images cached until their jobs are terminal. Operational execution holds still apply.

Completion validation requires the observed `runtimeDigest` to equal the admitted ID for completed runs and for any run containing an executed test observation. A timeout or infrastructure outcome with no executed observations can omit the ID; any provided conflicting ID is rejected. A rejected result does not append run evidence or settle a successful job. Trusted worker reporting and the existing harness limitations still apply: matching an ID is provenance validation, not proof that hostile learner code cannot tamper with a shared-process check.

## Migration, recovery and qualification

Historical run records without an image ID remain readable and are not rewritten. A queued legacy job without a valid binding fails before execution or inference, settles as definitely uncalled with zero actual spend, and tells the learner to explicitly request a new run after configuration is ready. The worker never silently chooses today's image for it. A missing admitted image similarly produces an infrastructure outcome; operators must restore the original image or leave the result as unexecuted and have the learner request a new run.

Unit fixtures use a Vitest-only mock of the trusted configuration boundary. No synthetic value is written into application defaults or `process.env`. Opt-in PostgreSQL and Docker suites require a real inspected `PYTHON_IMAGE_ID` exported before Vitest starts; their setup rejects a missing value. Runner unit tests use a mocked Docker process. Tests cover closed admission, alias approval, replay, lease takeover, absent or mismatched completion IDs, legacy jobs, frozen forwarding, and missing/mismatched cached images. The PostgreSQL regression checks persisted bindings, immutable input rollback, and completion rollback through independent adapters.

This change requires fresh SQL, isolated runner, browser and container-startup CI qualification. No local Docker or hosted deployment qualification was performed while implementing it. Image review, dedicated-worker isolation, external security review, and staged deployment gates remain required before a public launch.
