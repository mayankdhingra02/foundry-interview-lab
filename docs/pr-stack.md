# Pull request review order

The implementation is a dependency stack. Each PR targets the previous implementation branch; review from the smallest number upward. `main` remains the planning baseline and no PR has been merged by this task. Review the full inherited stack, update bases after merges and rerun required checks on the final merge candidate. A top-branch CI pass does not replace individual review or release approval.

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
| [#42](https://github.com/mayankdhingra02/foundry-interview-lab/pull/42) | Document delivered capabilities and review/release gates | `codex/evaluation-build-assets` |
| [#43](https://github.com/mayankdhingra02/foundry-interview-lab/pull/43) | Bind frozen test evidence to recorded runtime identity | `codex/delivery-review-handoff` |
| [#44](https://github.com/mayankdhingra02/foundry-interview-lab/pull/44) | Cancel pending microphone capture without late recording | `codex/evidence-runtime-identity` |
| [#45](https://github.com/mayankdhingra02/foundry-interview-lab/pull/45) | Check actual schema capabilities before reporting ready | `codex/voice-permission-cancellation` |
| [#46](https://github.com/mayankdhingra02/foundry-interview-lab/pull/46) | Add explicit capped model recording and comparison by AI role | `codex/schema-capability-readiness` |
| [#47](https://github.com/mayankdhingra02/foundry-interview-lab/pull/47) | Show saved public check source alongside execution output | `codex/controlled-model-benchmark` |
| [#48](https://github.com/mayankdhingra02/foundry-interview-lab/pull/48) | Bind custom evaluation snapshots and interruption provenance | `codex/public-check-source` |
| [#49](https://github.com/mayankdhingra02/foundry-interview-lab/pull/49) | Recover abandoned voice reservations without refunding uncertainty | `codex/faithful-evaluation-variants` |
| [#50](https://github.com/mayankdhingra02/foundry-interview-lab/pull/50) | Add independent role-specific model review and scoped quality metrics | `codex/stale-voice-reconciliation` |
| [#51](https://github.com/mayankdhingra02/foundry-interview-lab/pull/51) | Add a disposable synthetic save, execution and report canary | `codex/independent-role-review` |
| [#52](https://github.com/mayankdhingra02/foundry-interview-lab/pull/52) | Connect progression to configured, reviewed Foundry lesson destinations | `codex/disposable-component-canary` |
| [#53](https://github.com/mayankdhingra02/foundry-interview-lab/pull/53) | Explain retention periods, eligibility protections and external copies to learners | `codex/configured-foundry-lessons` |
| [#54](https://github.com/mayankdhingra02/foundry-interview-lab/pull/54) | Recover confirmation failures and protect deletion across account switches | `codex/learner-retention-disclosure` |
| [#55](https://github.com/mayankdhingra02/foundry-interview-lab/pull/55) | Qualify the synthetic component canary on a fresh isolated CI host | `codex/confirmation-recovery-owner` |
| [#56](https://github.com/mayankdhingra02/foundry-interview-lab/pull/56) | Persist advisory timing and written participation with recoverable extensions | `codex/qualify-component-canary` |
| [#57](https://github.com/mayankdhingra02/foundry-interview-lab/pull/57) | Author and run learner checks separately from protected contracts | `codex/advisory-timing` |
| [#58](https://github.com/mayankdhingra02/foundry-interview-lab/pull/58) | Retry pinned CI image provisioning after registry throttling | `codex/learner-regression-checks` |
| [#59](https://github.com/mayankdhingra02/foundry-interview-lab/pull/59) | Add three preparation tiers and family-aware progression | `codex/ci-registry-backoff` |
| [#60](https://github.com/mayankdhingra02/foundry-interview-lab/pull/60) | Add optional bounded practice measurement | `codex/three-level-curriculum` |
| [#61](https://github.com/mayankdhingra02/foundry-interview-lab/pull/61) | Add private acceptance corpus preparation and provenance tools | `codex/optional-practice-measurement` |
| [#62](https://github.com/mayankdhingra02/foundry-interview-lab/pull/62) | Add opaque operational support references | `codex/private-acceptance-corpus` |
| [#63](https://github.com/mayankdhingra02/foundry-interview-lab/pull/63) | Explain failed sign-in links and offer explicit retry | `codex/operational-support-reference` |
| [#64](https://github.com/mayankdhingra02/foundry-interview-lab/pull/64) | Make private corpus filesystem tests portable | `codex/sign-in-link-recovery` |
| [#65](https://github.com/mayankdhingra02/foundry-interview-lab/pull/65) | Qualify private corpus capture with isolated execution | `codex/portable-private-corpus-tests` |
| [#66](https://github.com/mayankdhingra02/foundry-interview-lab/pull/66) | Record and independently review private corpus model outputs | `codex/qualify-private-capture` |
| [#67](https://github.com/mayankdhingra02/foundry-interview-lab/pull/67) | Check dev advisory-chain isolation in both final images | `codex/private-role-evaluation` |
| [#68](https://github.com/mayankdhingra02/foundry-interview-lab/pull/68) | Respect report publication chronology in retest measurement | `codex/final-image-dependency-isolation` |

This table records the published focused implementation stack through PR #68. The final documentation handoff is a separate change based on #68; its own PR identifies the dependency. See [delivery status](delivery-status.md) for exact-head evidence and [design acceptance](design-acceptance.md) for external gates. No content approval, model/expert qualification or public deployment is implied.
