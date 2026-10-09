# Disposable private capture qualification

`tests/private-capture-docker.integration.test.ts` exercises private corpus capture on a dedicated disposable execution host, using the actual reviewed/provisioned immutable Python binding. CI explicitly includes it with `FOUNDRY_DOCKER_INTEGRATION=1` and `--no-file-parallelism`. The default local suite skips it; no shared local Docker invocation is required or authorized by this test's presence.

The four opt-in cases cover:

1. Two actual isolated snapshot executions, one correct and one deliberately broken independently authored implementation, through `capturePrivateCases`. Private cumulative checkpoints and final output are checked for `0700`/`0600` permissions, exclusive storage, exact snapshot/suite/runtime/input binding and selected-evidence roundtrip. Unselected captures do not become learner observations.
2. An actual isolated run inside an explicitly synthetic original-attempt interval. Its recorded-attempt origin is validated; a later-replay label is rejected. Offline captures likewise cannot be relabeled as original learner runs.
3. One actual completed capture and checkpoint before cancellation prevents the next case. Completed evidence remains intact without manufacturing an interrupted/unrun result.
4. Disabled/unacknowledged/duplicate/mismatched plans reject before execution or checkpoint writes. This is a zero-execution admission case, not another actual container run.

All data is operator-authored synthetic **development** material, explicitly unsealed and checked against the known benchmark index. It represents no actual learner, acceptance/holdout corpus, model output, human label or release approval. Four actual snapshot runs occur across the first three cases; each uses the scenario's authored suites and existing isolated runner. Fetch is forbidden and no provider calls, image pulls or host Python are used.

Read-only Foundry-container label checks require a clean context before and after each case. They detect leftover execution resources and never prune, restart or remove unrelated resources. These checks assume a dedicated context without competing Foundry jobs; serial test files prevent races with the other CI runner suites. Task-owned temporary files alone are removed by the test. Existing runner cleanup and hold behavior remain authoritative.

Local evidence: 49 deterministic private corpus tests passed, four new opt-in cases skipped, scoped lint and full typecheck passed. The four new cases passed in the completed isolated job of [fresh run 38005746642](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/38005746642), commit `e208afd`, alongside 49 total runner checks and 63 real SQL cases. Local cases remain honestly skipped; actual execution evidence comes from that owned CI VM. That result qualifies this capture path on that disposable host; it does not establish hosted execution security, historical operator authenticity, actual corpus custody, expert review or learner benefit. See [acceptance-corpus.md](acceptance-corpus.md) for the data contract and operator limits.
