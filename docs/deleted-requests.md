# Deleted request recovery

Deletion erases cached private responses. It also retains minimal owner-scoped request identities (request key and input fingerprint) in completed deletion metadata. Otherwise a delayed creation retry from another tab/device could recreate an erased attempt and debit another admission; an older account-deletion retry could erase newly created work.

An exact erased request returns HTTP410 with `error.code = request_deleted` before admission, billing or mutation. A changed fingerprint under that key still conflicts. Other owners cannot discover or replay the marker. An explicit new action uses a fresh request key. Normal successful deletion acknowledgments remain idempotent while their own cache exists.

Markers contain no submitted code, transcript, report, request body or cached response. Each deletion row contains at most100 key/hash pairs. Private session children and response copies are removed in the same transaction; minimal quota commitments remain separately accounted. Additional account-wide cache keys use a content-free cleanup record and cannot perform a delayed destructive replay. This preserves the shared identity and does not delete a Foundry account or payment subscription.

Completed marker metadata is eligible for the existing explicit retention operation only after30 days from deletion completion, subject to its cache dependencies and other protections. The replay guarantee ends when that metadata expires. Callers must not replay arbitrarily old intents; browser recovery blocks expired pending actions and asks learners to review saved attempts before explicitly discarding/replacing one. No automatic new request is generated after an expired/deleted result.

History can resolve a lost creation acknowledgment by matching the exact original request ID to `session.started.requestId` in an authenticated owned attempt. It clears only the matching pending creation, including immediately before deletion. Title/time/configuration similarity is not sufficient correlation. Unknown410 codes remain ambiguous; only the explicit deleted-request marker is terminal.

Unit/file tests cover erased creation and workspace retries, owner/fingerprint separation, old account-delete replay, bounded content-free rows, corrupt-marker handling and the explicit30-day retention boundary. A disposable PostgreSQL case verifies persisted markers across independent adapters, no second admission, erased private rows and preservation of a fresh attempt. Hosted retention/deletion/backup behavior remains separate qualification.
