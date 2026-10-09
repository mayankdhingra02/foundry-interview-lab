# Review notes

## Known incomplete starter behavior

The starter accepts invalid fields, uses floating point, and rounds half cents to even.

## Misconceptions and flawed approaches

- Using isinstance(value, int) alone accepts booleans.
- Rounding each line independently changes the result when several half cents accumulate.
- Happy-path values divisible by 100 do not test monetary precision.

## Review status

Automated reference and starter checks are tracked in docs/content-review.md. Independent expert review, rubric calibration, accessibility review, and learner trials remain open. Hints are ordered from orientation to explicit implementation guidance and must be shown only under the session help policy. Protected tests are coaching checks executed with untrusted code; they are not a tamper-resistant hiring grade.
