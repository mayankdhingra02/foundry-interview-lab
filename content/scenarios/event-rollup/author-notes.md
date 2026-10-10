# Review notes

## Known incomplete starter behavior

The starter groups by local dates, adds refunds, double-counts retries, and lacks consistent validation diagnostics.

## Misconceptions and flawed approaches

- A date string prefix is not a UTC reporting day.
- Deduplicating by raw JSON misses equivalent semantic timestamps and can treat field order as meaning.
- Skipping malformed input silently changes financial totals and breaks the stated failure contract.

## Review status

Automated reference and starter checks are tracked in docs/content-review.md. Independent expert review, rubric calibration, accessibility review, and learner trials remain open. Hints are ordered from orientation to explicit implementation guidance and must be shown only under the session help policy. Protected tests are coaching checks executed with untrusted code; they are not a tamper-resistant hiring grade.
