# Review notes

## Known incomplete starter behavior

The starter accepts negative quantities and performs a racy read followed by a write of the old count minus the request.

## Misconceptions and flawed approaches

- GIL or a process-local mutex is not a database-wide concurrency guarantee.
- A nonnegative final count alone can miss lost updates: compare accepted quantities too.
- Threads must create their own SQLite connections; sharing a connection tests another failure mode.

## Review status

Automated reference and starter checks are tracked in docs/content-review.md. Independent expert review, rubric calibration, accessibility review, and learner trials remain open. Hints are ordered from orientation to explicit implementation guidance and must be shown only under the session help policy. Protected tests are coaching checks executed with untrusted code; they are not a tamper-resistant hiring grade.
