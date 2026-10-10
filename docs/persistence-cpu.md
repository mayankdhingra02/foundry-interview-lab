# PostgreSQL unchanged-entity CPU diagnosis

Checked 2026-10-09. This is a local synthetic CPU comparison. It is not a PostgreSQL latency result, hosted capacity measurement, or replacement for the existing qualification gate.

## Motivation and bounded change

The initial normalized adapter reconstructs the represented database for each transaction. It then compares each previous/next entity by serializing, parsing and sorting canonical JSON on both sides. Most entities are unchanged. Cached request responses can contain complete historical SessionViews, so repeatedly normalizing those responses adds CPU and temporary allocations as saves accumulate.

The change is limited to `PostgresPracticeStore.sync`: `isDeepStrictEqual(previous.value,next.value)` skips the existing canonical comparison when the decoded values are already equal. Values that differ still use the original `persistedCanonical` fallback, including JSON normalization of optional properties, dates and numeric/array values. Insert/delete behavior, SQL statements, immutable evidence/job checks, scenario validation, transaction locking, capacity guards and the pre-COMMIT preflight are unchanged.

## Corpus and method

The baseline store source was captured from runtime-pinning commit `ddeb9a6`; its SHA-256 was `bb255cb811e41f6cc463e7b5784cf87e1ab684fbb1808abaa05508a822ec732a`. A scratch candidate added only the deep-equality skip before the same canonical fallback.

The corpus used the real MemoryPracticeStore and SessionService to create ten distinct synthetic owners/attempts of `monetary-validation`. Five interleaved save rounds added an original synthetic comment to one Python file per attempt: 50 acknowledged saves, with each before/after state retained for comparison. The completed corpus contained 200 normalized entities and 1,102,101 bytes of whole-state JSON. No real learner content, credentials, Docker, database sockets, speech/model services or public hosts were used.

Both variants ran against the same fake projected-row transport. It exercised the real store transaction/load/persist methods, with prepared corpus setup outside the timed interval. A second measurement called persist directly. Both included the same synthetic transport and cloning overhead. After warm-up, five alternating baseline/candidate trials ran on Node **v24.20.0**. Process CPU (`process.cpuUsage`) and elapsed wall time were recorded separately. An additional inspector CPU profile used a 500-microsecond sampling interval. The original scratch files/profiles live in the task's ignored `work/postgres-cpu/` directory; their timing thresholds are not CI tests.

## Count-only results

The baseline and candidate emitted **exactly equal SQL write statements and parameters** across all 50 transitions. Full transactions each issued 700 fake queries; persist-only runs each issued 350. No private values are included in this document.

| Measurement, 50 transitions | Baseline median | Candidate median | CPU reduction |
|---|---:|---:|---:|
| Full transaction process CPU | 763.47 ms | 501.02 ms | 34.4% |
| Persist-only process CPU | 582.61 ms | 306.01 ms | 47.5% |
| Full transaction wall time | 735.30 ms | 464.24 ms | Not a SQL latency result |
| Persist-only wall time | 564.82 ms | 288.60 ms | Not a SQL latency result |

Full-transaction CPU ranges were 722.88–766.42 ms baseline and 453.38–642.35 ms candidate. One candidate transaction trial took **1,035.25 ms wall time** despite 642.35 ms process CPU; that noisy observation is retained. Persisted-canonical wrapper calls fell from **15,800 to 3,550** per 50 full transactions, and from **12,350 to 100** in persist-only runs. The remaining full-transaction work includes load validation. Sampled canonical-function hits also fell, but those counts are diagnostic samples, not precise duration attribution.

## Real qualification evidence and limits

The earlier fresh-host batching run `37995389344` remains a recorded miss: real disposable SQL checks passed, all nine recovery checks were true, and its 50-save p95 was **1,122.86 ms** against the unchanged **1,000 ms** target. A later runtime-pinning run `37995581500` passed all four jobs before this optimization. The subsequent voice run `37996251785` again missed the load target at approximately **1,118 ms**, with its SQL tests passing and all recovery checks true. Host variance matters; these misses do not establish a universal defect, and the synthetic improvement does not establish that future SQL runs will pass.

`tests/postgres-sync.test.ts` verifies unchanged/changed cached responses, JSON-normalized equality, new/deleted replay records and immutable snapshot rejection. Existing PostgreSQL load/capacity/manifests/error checks remain required. Real PostgreSQL ownership, locking, rollback, durability and load qualification must still run on an isolated fresh host; this local work made no such claim. The larger initial adapter still loads all represented state and retains its existing capacity bounds. This optimization does not qualify expansion of those bounds.
