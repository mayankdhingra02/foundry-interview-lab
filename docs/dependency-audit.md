# Dependency advisory assessment

Checked **2026-10-09**, against repository HEAD `1a13950c24e98b803bc1a1941a0b2f77ea2d3e7d`, the current lockfile and installed packages, using Node `24.20.0` and npm `11.19.0`. This is a focused assessment of **GHSA-vfj7-8cjw-p6xm / CVE-2026-93687**, not a general security certification or a risk acceptance decision. Only this document was added; dependency manifests, installed packages, lint rules and Docker files were not changed. No local Docker operation was performed.

Assessed lockfile SHA-256: `32a8cd52af9a3e40196164df667c2400a8d2733057cd4701f9b80c0bbd24c843`. A later dependency or image change requires a new assessment rather than inheriting these conclusions automatically.

## Finding and exact graph

The supplied fresh `work/dependency-audit.json` reports five high-severity entries. They represent one underlying `braces` advisory and four dependent-package metavulnerability entries, rather than five independent defects:

```text
eslint-config-next@16.3.8                      dev dependency
└─ @next/eslint-plugin-next@16.3.8             dev: true
   └─ fast-glob@3.3.1                         dev: true
      └─ micromatch@4.0.8                     dev: true
         └─ braces@3.0.3                     dev: true
```

Both installed `npm ls ... --all --json` output and each exact `package-lock.json` node confirm this chain. The [GitHub-reviewed advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists versions through `3.0.3` as affected and no patched version. Its described impact is availability loss from deeply nested patterns reaching recursive AST walkers. The registry's current `braces` release is also `3.0.3`; no released version escape was found. The [upstream issue](https://github.com/micromatch/braces/issues/70) contains a maintainer dispute of the report and discussion of input limits. That disagreement does not remove the published advisory or establish a fix.

## Production and image scope

The following read-only checks were run:

| Check | Observed result | Limit |
| --- | --- | --- |
| `npm ls braces micromatch fast-glob eslint-config-next @next/eslint-plugin-next --omit=dev --all --json` | None of these packages appears in the production dependency tree. | Checks the installed dependency classification, not a deployed image. |
| Fresh `npm audit --omit=dev --json` | Empty vulnerabilities object; zero reported vulnerabilities. | Registry/lockfile advisory coverage only; not proof of absence of every vulnerability. |
| Lockfile inspection | All five nodes have `dev: true`; no duplicate production copy of this chain. | Vendored code and OS packages require separate assessment. |
| Local `.next/next-server.js.nft.json` inspection | 716 traced paths; no paths for these five packages. | Informative local artifact; its provenance is not a newly built final-image attestation. |
| Application source search | No imports/calls to this chain from `app`, `features`, `lib` or normal worker scripts. | Static reachability evidence; the container-smoke script contains development-package absence checks. |

The production audit output is retained outside the repository in `h/work/dependency-security/production-audit.json`. npm's dependency-count metadata still describes the full lockfile: it must not be read as proof that every counted dev package is installed in production. npm documents that omitted classes are excluded from the audit payload/report and from installation, while remaining in the lockfile. [npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/)

The Docker build separates these scopes explicitly:

- `Dockerfile:4–7`, `dependencies`: runs full `npm ci`; the affected dev chain is present.
- `Dockerfile:14–25`, `builder`: receives the full dependency tree for compilation. Its default build command does not invoke the separate `lint` script, but the vulnerable code remains installed in this build stage.
- `Dockerfile:9–12`, `production-dependencies`: independently runs `npm ci --omit=dev`.
- `Dockerfile:27–39`, `application`: copies `node_modules` from **production-dependencies**, plus application build/source assets. It does not copy the builder's full `node_modules` or lint configuration.
- `Dockerfile:41–47`, final `worker` and `web`: both inherit `application`; the worker additionally receives the Docker CLI.

Therefore this exact npm chain is excluded from the final web/worker dependency tree **when built from this lockfile with this Dockerfile**. That is a source/graph conclusion, not a fresh container scan. At the assessed head, `scripts/operations/container-smoke.ts` checked four development tools only. A separate follow-up now extends runtime-context resolution checks to the full eight-package list in both web and worker images; see [dependency-isolation.md](dependency-isolation.md). Its actual image execution needs fresh CI before qualification. A final-image SBOM remains separate work; resolution checks do not inventory nested/vendored copies. This assessment does not cover base-image OS packages, the added Docker CLI, all vendored framework code, or other advisory classes.

## Next ESLint reachability

The installed plugin's `dist/utils/get-root-dirs.js:14–29` calls `fast-glob.globSync` when `settings.next.rootDir` is a string or array. With that setting absent, it uses `context.cwd` directly. Its consumer is `no-html-link-for-pages`; a source search found no other consumer of this helper in the installed plugin. Next documents `rootDir` as a path/glob or array. [Next ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint#specifying-a-root-directory-within-a-monorepo)

This repo's `eslint.config.mjs` enables the current Core Web Vitals and TypeScript flat configurations and does not set `settings.next.rootDir`. An in-memory diagnostic wrapped `fast-glob.globSync` without editing any package or repository file, then linted a small synthetic TSX component with the actual config:

| Diagnostic | Next internal-link rule | `globSync` calls | Lint errors |
| --- | --- | --- | --- |
| Actual repo configuration | Enabled, severity 2 | 0 | 0 |
| Explicit benign `rootDir: '.'` override | Enabled, severity 2 | 1 | 0 |

This confirms the present setting avoids the identified glob call; it does not patch the dependency. If a future monorepo/config change enables arbitrary root globs, `fast-glob` enables brace expansion by default and routes through `micromatch.braces(..., {expand:true})`. The installed `braces` implementation has the relevant recursive walkers. Keep root patterns trusted and bounded and review any new use of these APIs. Learner code/answers are not supplied as ESLint root globs in the current application.

Development and CI still install the affected package, and `.github/workflows/check.yml:31–35` runs repository lint with it. Malicious config changes or a future path that passes untrusted patterns remain build/development availability risks. The current lack of a learner HTTP-to-glob path narrows exposure; it is not a waiver of the high advisory or a reason to disable lint/advisory checks.

## Remediation assessment and recommendation

Read-only official npm registry metadata was checked on the same date:

| Candidate | Evidence | Recommendation |
| --- | --- | --- |
| npm's suggested `eslint-config-next@14.2.35` downgrade | Declares ESLint `^7.23.0 \|\| ^8.0.0`, whereas this project uses ESLint 9 and Next 16 flat configs. Also changes the Next/React Hooks lint baseline. | Do not run `npm audit fix --force` or take this downgrade automatically. It is not a reviewed compatible fix. |
| Latest `@next/eslint-plugin-next@16.4.0` | Still declares `fast-glob: 3.3.1`. | Does not remove this chain. Do not upgrade the framework solely to claim remediation. |
| Latest `fast-glob@3.3.3` | Still depends on `micromatch: ^4.0.8`; current micromatch retains braces. | A simple fast-glob override does not fix this advisory. |
| Override braces to an older release | Advisory covers every published release through `3.0.3`. | No fixed older target exists. |
| Scoped replacement of the plugin's glob dependency | `tinyglobby@0.2.17` exposes a glob API and depends on `fdir`/`picomatch`, without braces in its declared dependencies. | Only an investigation candidate. A package alias is not proven API/semantic compatibility and must not be installed blindly. |
| Reviewed maintained patch/fork with explicit nesting/input guards | Could preserve the full lint rule set while bounding the affected operation. | No qualified patch was selected or applied in this assessment; ownership, provenance, compatibility and continued updates would be required. |

Registry evidence: [old config peers](https://registry.npmjs.org/eslint-config-next/14.2.35), [current plugin](https://registry.npmjs.org/@next%2feslint-plugin-next/16.4.0), [fast-glob](https://registry.npmjs.org/fast-glob/3.3.3), [braces](https://registry.npmjs.org/braces/3.0.3), [replacement candidate](https://registry.npmjs.org/tinyglobby/0.2.17). These are observed versions, not a promise about future registry state.

**Recommendation:** retain the compatible dependency graph and all lint rules for now, keep this advisory explicitly open with its dev/build exposure recorded, and recheck the upstream advisory/releases before the next release decision. Preserve the existing production omission. Qualify the added full-chain runtime-resolution assertions and obtain separate SBOM inspection on the final images. A security owner must decide whether the remaining dev/build risk is acceptable; this document does not grant that acceptance.

If policy requires immediate removal of the alert, first evaluate a narrowly scoped, pinned replacement or reviewed patch in a disposable dependency copy. Required evidence includes the actual plugin import/API shape; root-directory behavior for literal paths, arrays, relative/absolute paths, Windows normalization and brace/glob patterns; unchanged enabled rule sets and representative diagnostics; full repository lint/typecheck/build; fresh full/production audits; and final web/worker smoke/SBOM checks. Only then propose a focused dependency PR. Removing the plugin/rule to hide the alert, raising audit thresholds, or reclassifying the dev dependency as safe without evidence would weaken the existing checks.
