# Development setup

Use Node 24 and Python 3.11. `main` is the planning baseline while implementation PRs await review. Check out the latest implementation branch linked from [delivery status](delivery-status.md) or the [open PR stack](https://github.com/mayankdhingra02/foundry-interview-lab/pulls) before running the application.

Install with `npm ci`, copy `.env.example` to `.env.local`, run `chmod 600 .env.local`, replace `SESSION_SECRET` with at least 32 cryptographically random characters, and run `npm run dev`. The server binds to `127.0.0.1` by default. Keep `.env.local`, attempts, exports, provider credentials and local data outside Git. `GET /api/health` reports configured capabilities without exposing secrets. [Readiness](operations.md) separately checks operational availability; a configured runner is not proof of a successful test run.

Local identity is a signed, HTTP-only development cookie and local attempts use file storage. Both development identity and the production file-storage fallback are disabled in production. Hosted accounts require the configured Supabase public URL/anonymous key, an allowed callback at `/auth/callback`, and a verified session. Client-supplied owner IDs are never authoritative. `DATABASE_URL` is a separate private trusted-server connection, never a browser credential.

No model key is required to explore catalog, saved work and authored debrief questions. The interface labels authored questions and unassessed reports. AI assistance and assessed coaching require separately configured capabilities; report generation has an independent flag. Speech and billing default off. Production new-attempt admission defaults to staff with no admitted scenarios. Read [rollout](rollout.md) before enabling anything.

Actual learner execution requires healthy Docker on a dedicated trusted execution host and a deliberately provisioned approved Python image and its exact `PYTHON_IMAGE_ID`; see [runtime binding](runtime-binding.md). The runner uses cached images, never pulls on learner requests, and never executes learner code on the application host. It returns a visible infrastructure failure when unavailable. Do not point local qualification at shared/production databases or use privileged product secrets inside execution containers. See [execution](execution.md).

`npm run worker` starts the durable worker with the same private database/configuration as the web application. Development can also drain work locally through the API. Production requires separate long-running worker deployment and shared readiness/cleanup state. Apply reviewed ordered SQL migrations before their dependent writers; application startup does not apply DDL. See [deployment](../deploy/README.md) and [persistence](persistence.md).

## Verification

`npm run check` runs typecheck, ESLint, default Vitest tests and the production webpack build. `npm run test:e2e` runs Playwright against an already running application. Its default URL is `http://127.0.0.1:3134` and default channel is installed Google Chrome. For the usual development port, run `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npm run test:e2e`. To use Playwright Chromium, install it with `npx playwright install chromium` and set `PLAYWRIGHT_CHANNEL=chromium`. Default tests explicitly skip opt-in Docker/PostgreSQL cases. A skipped integration is not a pass.

Fresh-host [CI](ci.md) additionally requires isolated execution, real PostgreSQL ownership/transaction/commerce/voice/review/retention cases, durability/replay/fencing/load/restore checks, browser recovery, both deployment builds and startup smoke. Synthetic tests make no paid model/speech requests. Each PR records its exact commit's checks and qualification limits. Preserve failures and fix causes; do not lower gates or repeatedly retry unchanged code to conceal a miss.

Use task-owned disposable fixtures. Do not restart or prune a shared Docker installation to make these tests pass. Local host storage I/O errors are an operational blocker for local container tests; fresh CI is the supported independent qualification boundary until the host is repaired by its owner.

## Dependency decisions

The initial design inspected Next 16.3.4 in the existing Foundry checkout. This repository starts with Next 16.3.8 to include patched security fixes; no dependency in the original Foundry checkout was changed. See the [ImageResponse advisory](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j).

The initial installation also reported the unpatched [braces stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) through development-only Next ESLint tooling. The lint tool receives repository-controlled paths, not learner patterns. Recheck upstream updates and production dependency audit before release; an obsolete major downgrade is not an accepted remediation.
