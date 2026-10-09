# A midnight reporting discrepancy

Explore an unfamiliar ingestion pipeline and fix daily totals with time zones, refunds, and repeated deliveries. Preserve the documented public interface. Use only Python 3.11 standard-library modules.

## Requirements

- Preserve build_report(lines), read_events(lines), and aggregate(events). build_report accepts a one-pass iterable of JSON strings; blank lines are ignored.
- Each nonblank line is an object with nonempty string event_id/customer_id, kind purchase or refund, positive integer amount_cents (not bool), and an ISO 8601 occurred_at with an explicit timezone. Extra fields may be ignored.
- Normalize occurred_at to UTC before assigning its calendar day. Purchases add cents; refunds subtract cents. Refund-only and net-zero rows are retained.
- event_id is globally unique within one report. An identical semantic retry counts once; a conflicting retry raises ValueError. Equivalent timestamps with different offsets represent the same instant.
- Return dictionaries with customer_id, day (YYYY-MM-DD in UTC), and net_cents, sorted by customer_id then day. Do not mutate caller inputs.
- Malformed records raise ValueError whose message includes the original physical line number. Conflicting IDs raise ValueError without a required line number. No partial report is returned on failure.

## Working agreement

Inspect the modules, implement the requirements, and verify the behavior with tests. Public checks illustrate the contract; protected checks cover the same disclosed contract, not new requirements. You may add your own tests. No network or external dependencies are needed. Explain your assumptions and any remaining uncertainty during the debrief.
