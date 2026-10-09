# Review notes

## Known incomplete starter behavior

The starter preserves ordinary CSV but ignores status and rejects JSONL.

## Misconceptions and flawed approaches

- Joining strings with commas corrupts CSV containing commas, quotes, or line breaks.
- Serializing the entire input dictionary can expose internal fields.
- Inspecting a generator to check emptiness consumes it and may drop the first row.

## Review status

Automated reference and starter checks are tracked in docs/content-review.md. Independent expert review, rubric calibration, accessibility review, and learner trials remain open. Hints are ordered from orientation to explicit implementation guidance and must be shown only under the session help policy. Protected tests are coaching checks executed with untrusted code; they are not a tamper-resistant hiring grade.
