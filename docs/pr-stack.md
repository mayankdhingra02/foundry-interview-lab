# Pull request review order

The implementation is a dependency stack. Every PR targets its predecessor; review from the smallest number upward. The current `main` is the planning baseline. No pull request has been merged by this task. Before release, review the inherited stack, update bases after merges and rerun checks on the final merge candidate. The documentation handoff PR follows this implementation stack.

| PR | Change | Base branch |
| --- | --- | --- |
| [#1](https://github.com/mayankdhingra02/foundry-interview-lab/pull/1) | Add application foundation and private identity boundary | `main` |
| [#2](https://github.com/mayankdhingra02/foundry-interview-lab/pull/2) | Implement transactional sessions and frozen evidence | `codex/application-foundation` |
| [#3](https://github.com/mayankdhingra02/foundry-interview-lab/pull/3) | Add five versioned practice scenarios and a safe catalog | `codex/session-engine` |
| [#4](https://github.com/mayankdhingra02/foundry-interview-lab/pull/4) | Run immutable practice snapshots in isolated Docker containers | `codex/scenario-catalog` |
| [#5](https://github.com/mayankdhingra02/foundry-interview-lab/pull/5) | Persist private practice evidence and durable jobs in PostgreSQL | `codex/isolated-execution` |
| [#6](https://github.com/mayankdhingra02/foundry-interview-lab/pull/6) | Add evidence-grounded interviewer, assistant, and coach roles | `codex/postgres-persistence` |
| [#7](https://github.com/mayankdhingra02/foundry-interview-lab/pull/7) | Connect private practice commands to durable job processing | `codex/evidence-grounded-ai` |
| [#8](https://github.com/mayankdhingra02/foundry-interview-lab/pull/8) | Build the resumable learner workspace and evidence-linked practice review | `codex/practice-api-worker` |
| [#9](https://github.com/mayankdhingra02/foundry-interview-lab/pull/9) | Add verified commerce webhooks and atomic practice entitlements | `codex/learner-workspace` |
| [#10](https://github.com/mayankdhingra02/foundry-interview-lab/pull/10) | Add optional press-to-talk speech with consent and atomic usage limits | `codex/commerce-entitlements` |
| [#11](https://github.com/mayankdhingra02/foundry-interview-lab/pull/11) | Minimize recognizable credentials before model inference | `codex/optional-voice` |
| [#12](https://github.com/mayankdhingra02/foundry-interview-lab/pull/12) | Add evidence-bound evaluation benchmark and release gates | `codex/model-input-privacy` |
| [#13](https://github.com/mayankdhingra02/foundry-interview-lab/pull/13) | Add durable worker operations and deployment qualification | `codex/evaluation-benchmark` |
| [#14](https://github.com/mayankdhingra02/foundry-interview-lab/pull/14) | Add learner billing controls and retry-safe data deletion | `codex/operations-deployment` |
| [#15](https://github.com/mayankdhingra02/foundry-interview-lab/pull/15) | Validate typed practice events and replay ordering | `codex/learner-billing-data` |
| [#16](https://github.com/mayankdhingra02/foundry-interview-lab/pull/16) | Add permissioned support and independently reviewed report corrections | `codex/typed-practice-events` |
| [#17](https://github.com/mayankdhingra02/foundry-interview-lab/pull/17) | Add learner disputes and staff review workspaces | `codex/permissioned-support` |
| [#18](https://github.com/mayankdhingra02/foundry-interview-lab/pull/18) | Add persistent learner interview controls | `codex/review-workspaces` |
| [#19](https://github.com/mayankdhingra02/foundry-interview-lab/pull/19) | Fix PostgreSQL event and permission-error compatibility | `codex/interview-controls` |
| [#20](https://github.com/mayankdhingra02/foundry-interview-lab/pull/20) | Batch PostgreSQL loads without weakening capacity checks | `codex/postgres-event-compatibility` |
| [#21](https://github.com/mayankdhingra02/foundry-interview-lab/pull/21) | Add evidence-based progress and personal practice plans | `codex/postgres-load-batching` |
| [#22](https://github.com/mayankdhingra02/foundry-interview-lab/pull/22) | Control scenario admission, rollout groups, and paid coaching | `codex/evidence-based-progression` |
| [#23](https://github.com/mayankdhingra02/foundry-interview-lab/pull/23) | Use pinned official CI images and avoid duplicate runs | `codex/controlled-rollout` |
| [#24](https://github.com/mayankdhingra02/foundry-interview-lab/pull/24) | Keep AI and speech settlements in their original budget windows | `codex/ci-image-provisioning` |
| [#25](https://github.com/mayankdhingra02/foundry-interview-lab/pull/25) | Add bounded operational retention with protected replay and quota accounting | `codex/utc-budget-windows` |
| [#26](https://github.com/mayankdhingra02/foundry-interview-lab/pull/26) | Enforce monthly speech budgets and settle erased work safely | `codex/operational-retention` |
| [#27](https://github.com/mayankdhingra02/foundry-interview-lab/pull/27) | Verify admitted worker inputs before execution and inference | `codex/voice-erasure-accounting` |
| [#28](https://github.com/mayankdhingra02/foundry-interview-lab/pull/28) | Roll back persistence overflow and restrict private job reads | `codex/worker-input-verification` |
| [#29](https://github.com/mayankdhingra02/foundry-interview-lab/pull/29) | Recover ambiguous learner actions with stable identities across reload | `codex/persistence-write-safety` |
| [#30](https://github.com/mayankdhingra02/foundry-interview-lab/pull/30) | Remove duplicate JSON payloads from PostgreSQL entity reads | `codex/reload-safe-recovery` |
| [#31](https://github.com/mayankdhingra02/foundry-interview-lab/pull/31) | Prevent erased requests from recreating attempts or deleting fresh work | `codex/projected-persistence-reads` |
| [#32](https://github.com/mayankdhingra02/foundry-interview-lab/pull/32) | Bound shared learner write growth and pending work atomically | `codex/deleted-request-recovery` |
| [#33](https://github.com/mayankdhingra02/foundry-interview-lab/pull/33) | Complete learner recovery for erased, expired and pending AI actions | `codex/bounded-practice-admission` |
| [#34](https://github.com/mayankdhingra02/foundry-interview-lab/pull/34) | Batch immutable scenario validation and repair SQL transport measurement | `codex/complete-learner-recovery` |
| [#35](https://github.com/mayankdhingra02/foundry-interview-lab/pull/35) | Pin admitted runs to a reviewed immutable runtime | `codex/batched-scenario-validation` |
| [#36](https://github.com/mayankdhingra02/foundry-interview-lab/pull/36) | Add safe undo for accepted AI edits with retained provenance | `codex/immutable-runtime-admission` |
| [#37](https://github.com/mayankdhingra02/foundry-interview-lab/pull/37) | Add a private read-only evaluation review library | `codex/accepted-edit-undo` |
| [#38](https://github.com/mayankdhingra02/foundry-interview-lab/pull/38) | Persist voice choice and add explicit local microphone setup | `codex/internal-evaluation-library` |
| [#39](https://github.com/mayankdhingra02/foundry-interview-lab/pull/39) | Replay acknowledged work before current capability admission | `codex/explicit-voice-setup` |
| [#40](https://github.com/mayankdhingra02/foundry-interview-lab/pull/40) | Reduce persistence CPU while preserving write semantics | `codex/replay-before-capability-admission` |
| [#41](https://github.com/mayankdhingra02/foundry-interview-lab/pull/41) | Allowlist fixed evaluation dependencies in deployment builds | `codex/persistence-comparison-cpu` |

The assembled implementation is on `codex/evaluation-build-assets` at `dc16c27`; the following handoff branch adds delivery/review documentation. Neither replaces individual reviews, content/quality approval or deployment qualification. See [delivery status](delivery-status.md) for measured checks and external gates.
