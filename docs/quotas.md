# UTC budget-window accounting

AI and voice admission share content-free ledger USD accounting. A reservation consumes budget in the UTC day/month when it is admitted. Its later settlement adjusts that same reservation window, even if a response, cancellation, or retry crosses midnight or the end of a month. The ledger's actual posting `createdAt` and provider inference start/completion timestamps remain unchanged.

Previously, admission summed every posting by `createdAt`. Reserving $0.08 before midnight and settling at $0.02 after midnight added a -$0.06 credit to the new day's budget. The same credit could also increase the new month or voice allowance. The corrected new-window total excludes that old-window credit; the prior-window reservation becomes $0.02.

## Ledger contract and compatibility

`LedgerEntry` adds optional `budgetAt:string`. New AI and voice reservations mark `budgetAt == createdAt`. AI settlement/uncertain postings inherit the exact original job-and-reservation-sequence timestamp. Voice terminal postings inherit their voice reservation timestamp and retain their existing zero USD delta. All fields are content-free; they contain no code, transcript, report, or provider response.

`lib/interview-practice/quota.ts` exports:

- `budgetTotals(ledger, ownerId, now)` returns `userDailyUsd`, `userMonthlyUsd`, and `globalDailyUsd` in UTC.
- `reservationBudgetAt(ledger, {ownerId,sessionId,operationId})` finds one exact original reservation; duplicates/missing rows return no inferred timestamp.
- `ledgerBudgetGroupKey(entry)` supplies the shared whole-operation identity for conservative retention.

Grouping includes owner ID, session ID, and the complete operation prefix. AI keys such as `jobId:2:reserve` and `jobId:2:settle` retain reservation sequence 2; they cannot match sequence 1. Voice `reserved`/`settled` suffixes are supported. Legacy rows without `budgetAt`, including unsequenced legacy operation prefixes, associate only through that exact scoped identity. The original reservation admission clock remains authoritative. Invalid dates, invalid money, or reservation metadata that attempts to move its original window fail closed with a static operator-review error.

Terminal `budgetAt` metadata alone never authorizes a credit. A negative delta requires exactly one matching nonnegative reservation, exactly one settlement, and no uncertainty marker. A credit cannot exceed that reservation's amount. Orphan, duplicate, ambiguous, wrong-owner, wrong-session, wrong-sequence, and uncertain credits do not reduce any window. Positive orphan charges remain counted at their actual posting time. Ambiguous records remain conservative until separately reviewed; this helper does not invent a financial reconciliation or erase an uncertain charge.

This is application quota attribution, rather than a promise about a provider invoice's accounting period. Known actual cost may exceed an estimate; the excess still belongs to the original reservation window and remains visible as a positive delta. Existing per-session commitment accounting continues to combine reserved, spent, and uncertain USD over the lifetime of the attempt. Admission caps, assistance call counts, retry limits, voice seconds/minutes, and provider cost estimates have not been lowered or refunded by this change.

## Atomic admission and retries

`SessionService.reserve` calls the shared helper inside the existing store transaction for owner daily/monthly and global daily USD checks. It then appends the reservation and updates the session commitment. `settle` appends the actual delta or uncertainty marker with original-window metadata. A lease takeover keeps the earlier reservation uncertain and creates a separately numbered new reservation in the retry's own window. Stale worker results remain fenced and cannot create a later credit.

`reserveVoice` uses the same helper for its owner/global daily USD checks, so AI settlement credits cannot fund extra speech after midnight. Voice minute accounting stays conservative and follows the original reserved seconds. Speech terminal postings continue to carry a zero USD delta; failed or short playback does not refund allocated minutes or the bounded reserved speech cost.

The file adapter stores `budgetAt` in the existing ledger JSON. The PostgreSQL adapter already persists the complete ledger entity in its bounded normalized `runtime_payload`, so this optional field needs no new SQL column or migration. Legacy data is read compatibly without rewriting historical rows. No new PostgreSQL runtime qualification is claimed for this quota change until its CI tests execute.

## Deletion and retention

Lab-data/session deletion continues to remove private attempts while preserving content-free quota postings under the existing 62-day policy. Shared identity and separate commerce consumption are unchanged. Window reconstruction uses retained ledger identity, rather than a live session or job, so deleting an attempt cannot make a refund credit migrate into another day or reset spend.

Retention must remove eligible financial groups together. Do not prune an original reservation while retaining a settlement/uncertain posting that depends on it, or remove still-relevant current-window budget references. Pending, uncertain, orphan, and ambiguous groups require the separately documented conservative retention policy. The grouping helper is available so the retention CLI can reuse the same owner/session/sequence identity. `createdAt` remains the actual posting timestamp and the current SQL expiry source; `budgetAt` is not permission to expire a newer posting early.

## Validation

Twenty-two deterministic quota tests cover UTC day/month boundaries; legacy and offset timestamps; exact owner/session/retry association; orphan and overlarge credits; duplicate/uncertain terminals; invalid metadata; unchanged inference clocks; lease takeover; deletion/recreation; and shared AI/voice owner/global caps. They use synthetic job outcomes and no provider calls or spending.

```sh
npm test -- tests/quota.test.ts tests/domain.test.ts tests/voice.test.ts
npm run typecheck
npx eslint lib/interview-practice/quota.ts lib/server/session-service.ts lib/voice/ledger.ts tests/quota.test.ts
```

Local Docker is prohibited for this workstream. Existing real-SQL suites will exercise entity round trips in fresh authorized CI. Deterministic tests establish accounting behavior; they do not establish hosted quotas, provider bill accuracy, workload capacity, or production retention execution.
