# Review notes

## Known incomplete starter behavior

The starter always inserts and accepts invalid payloads.

## Misconceptions and flawed approaches

- A global event_id constraint merges legitimate deliveries from different merchants.
- INSERT OR REPLACE can change IDs or overwrite previously recorded facts.
- An in-memory set does not survive restart and does not coordinate separate workers.

## Review status

Automated reference and starter checks are tracked in docs/content-review.md. Independent expert review, rubric calibration, accessibility review, and learner trials remain open. Hints are ordered from orientation to explicit implementation guidance and must be shown only under the session help policy. Protected tests are coaching checks executed with untrusted code; they are not a tamper-resistant hiring grade.
