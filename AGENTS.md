# Foundry Interview Lab development

Read the relevant guides in `node_modules/next/dist/docs` before editing Next application code. This project uses Next 16 and asynchronous request APIs.

The implementation target is `docs/design.md`. Track incomplete requirements and release evidence honestly. A provider adapter, generated fixture, or passing unit test does not establish production qualification or expert review.

Keep work in focused PRs by capability. Do not bundle the whole product into one PR. Document dependencies when a PR is stacked on another unmerged PR.

Preserve the separation between interviewer, coding assistant and coach; authorization and state transitions belong to deterministic server policy. Never execute learner code on the application host or expose reference solutions through public DTOs.

Reuse the Foundry warm paper, ink and rust palette. Verify rendered pages and keyboard behavior at desktop and narrow widths. Keep learner artifacts, credentials, and private operational traces outside Git.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
