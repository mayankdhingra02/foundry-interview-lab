# Development setup

Use Node 24 and npm. Copy `.env.example` to `.env.local`, generate a random `SESSION_SECRET`, then run `npm ci` and `npm run dev`. The server binds to `127.0.0.1` by default. `GET /api/health` reports configured capabilities without exposing secrets.

Local identity is a signed, HTTP-only development cookie. It is disabled in production. Hosted accounts require Supabase URL/anonymous key configuration, an allowed callback at `/auth/callback`, and a verified account session. Client-supplied owner IDs are never authoritative.

The foundation PR provides runtime tooling, request validation, health and identity routes. Domain, catalog, worker, persistence and workspace capabilities arrive in dependent focused PRs. Follow [delivery status](delivery-status.md) for the complete target.

## Verification

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`

CI uses Node 24 and Python 3.11. Model and runner credentials are never required for static checks or deterministic fixtures. Live integration qualification remains a separate requirement.

## Dependency decisions

The initial design inspected Next 16.3.4 in the existing Foundry checkout. This repository starts with Next 16.3.8 to include patched security fixes. See [the ImageResponse advisory](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j). No dependency in the original Foundry checkout was changed.

As of the initial installation, npm also reports the unpatched [braces stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) through development-only Next ESLint tooling. The lint tool receives repository-controlled paths, not learner patterns. Do not apply npm's suggested major downgrade to an obsolete Next lint configuration. Recheck upstream updates and the production dependency audit before release.
