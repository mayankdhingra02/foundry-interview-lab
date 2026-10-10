# CI provisioning and qualification

The verification workflow runs for pull requests and pushes to `main`. Feature-branch pushes are verified through their pull request, avoiding a second identical run for each push. A workflow-level concurrency key includes the pull-request number, or the branch ref for `main`, and cancels older runs for that same key. Separate stacked pull requests still receive separate qualification. See GitHub's [trigger syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Image source and trust boundary

CI provisions Docker Official Images from the verified Docker publisher on Amazon ECR Public. AWS documents this publisher in its [Docker Official Images announcement](https://aws.amazon.com/blogs/containers/docker-official-images-now-available-on-amazon-elastic-container-registry-public/) and documents [unauthenticated public pulls](https://docs.aws.amazon.com/AmazonECR/latest/public/docker-pull-ecr-image.html). This uses no AWS account, access key, login, repository creation, or paid service integration. Public registries can still throttle or become unavailable; failures remain visible and fail the job.

The exact public image tag manifests were verified by read-only registry requests on 2026-10-09. All four returned HTTP 200 with an OCI image index. The workflow pins those verified index digests:

| Official publisher repository | Tag | Verified index digest |
| --- | --- | --- |
| [Python](https://gallery.ecr.aws/docker/library/python) | `3.11-slim` | `sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce` |
| [PostgreSQL](https://gallery.ecr.aws/docker/library/postgres) | `16-alpine` | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| [Node](https://gallery.ecr.aws/docker/library/node) | `24-bookworm-slim` | `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` |
| [Docker CLI](https://gallery.ecr.aws/docker/library/docker) | `29-cli` | `sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00` |

Provisioning first checks for that exact cached source image. If absent, it pulls only the pinned ECR Public reference; it has no Docker Hub fallback and no test retry loop. It logs the public repository digest. Python and PostgreSQL are tagged locally as `python:3.11-slim` and `postgres:16-alpine`, preserving the runner, browser and disposable-database test contracts. Deployment-image builds pass the pinned mirror references through `NODE_IMAGE` and `DOCKER_CLI_IMAGE` build arguments. Including the Docker CLI base avoids a later worker-build dependency on Docker Hub.

`Dockerfile` defaults remain `node:24-bookworm-slim` and `docker:29-cli`. The later [runtime admission](runtime-binding.md) change requires a reviewed immutable `PYTHON_IMAGE_ID` for new runs. Each execution-capable CI job exports the actual provisioned image ID, while keeping source digests and aliases distinct. The operations scripts already start cached images with `--pull=never`; they never provision or pull an image during qualification. The execution runner keeps its existing cached-image boundary. This CI digest set is not a production image approval or vulnerability qualification; deployment operators still review and pin release images. Update the CI digests deliberately with upstream provenance and repeat qualification after each change.

## Tests and evidence

Every existing verification step remains required: TypeScript, lint, deterministic tests, application build, real container isolation, all opt-in PostgreSQL integration suites, operational durability/replay/fencing/restore qualification, browser recovery, both deployment builds, and container startup smoke. No tests, latency thresholds, recovery checks, or failure statuses are weakened. The operational save p95 target remains strictly below 1000 ms.

The failure evidence preceding this change is preserved:

- [Run 37990482184](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/37990482184), PostgreSQL compatibility branch: both Python provisioning jobs failed with Docker Hub `toomanyrequests`; the Node base manifest lookup failed with HTTP 429.
- [Run 37990606872](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/37990606872), PostgreSQL loader batching branch: the same Python and Node rate-limit failures occurred.

These runs stopped before SQL and operational qualification, so they establish neither success nor failure of those application changes. The earlier measured operational p95 miss and later pre-optimization pass remain recorded in `docs/persistence.md` and `docs/operations.md`; this provisioning change does not replace those results.

Local validation for this change checks workflow parsing, shell syntax and provisioning branches using a fake Docker command, plus the Dockerfile argument/default structure. No local Docker command, image download, container, hosted database, model call or Stripe mutation is used. Read-only manifest verification establishes that the exact public references exist. [Run 37991414516](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/37991414516) qualified the actual pinned pulls, both deployment builds/startup, 36 SQL cases, 26 runner cases, browser recovery and p95 834 ms. [Runtime run 37995581500](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/37995581500) later passed all four jobs with 45 SQL cases, 30 runner cases and p95 818 ms. Intermediate measured load failures and the repaired SQL diagnostic remain documented in [delivery status](delivery-status.md) and [batching](persistence-batching.md). These are disposable CI results; the final merge candidate and chosen deployment need their own qualification.

## Historical account block and fresh qualification

Starting with [run 37996427210](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/37996427210), all four jobs had no runner assignment and no executed steps. GitHub reported account payment/spending restrictions. This is historical: fresh jobs subsequently ran again without this task changing billing or repository visibility. [Run 38004051618](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/38004051618), commit `1a13950`, passed all four jobs with 36 runner checks (17 real Docker cases), 63 PostgreSQL cases, 124 browser checks, deployment images/startup, the real-execution component canary and unchanged load/restore checks. Newer heads and the final merge candidate need their own qualification.

The preceding PR #57 deployment job failed before building when public ECR returned `toomanyrequests: Rate exceeded`. PR #58 added a fresh-CI-only helper with three bounded pull attempts and 10/20-second backoff, preserving exact immutable image references. Cached pins avoid a pull; exhaustion fails explicitly. No mutable fallback, threshold weakening or shared local Docker repair is used. The failed result remains recorded separately from the subsequent pass.
