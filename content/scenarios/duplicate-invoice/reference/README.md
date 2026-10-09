# Duplicate Invoice Incident

Make payment webhook retries safe across restarts without merging distinct merchants or changing a stored invoice. Preserve the documented public interface. Use only Python 3.11 standard-library modules.

## Requirements

- Preserve PaymentEvent, InvoiceStore(path=":memory:"), store.insert(event), store.all(), store.close(), and create_invoice(store, event).
- Identify a delivery by (merchant_id, event_id). An identical retry returns the original invoice ID and creates no additional row.
- The same event_id may be used by two merchants; different event_id values are distinct deliveries.
- Reusing the same delivery key with a different amount raises ValueError and preserves the original row. A later unrelated delivery must still work.
- Reject non-string or whitespace-only identifiers and non-positive or non-integer amounts with ValueError before writing; booleans are not valid amounts.
- Retries must remain safe after closing and reopening the same database. A process-local cache alone is insufficient. No migration of pre-existing malformed databases is required.

## Working agreement

Inspect the modules, implement the requirements, and verify the behavior with tests. Public checks illustrate the contract; protected checks cover the same disclosed contract, not new requirements. You may add your own tests. No network or external dependencies are needed. Explain your assumptions and any remaining uncertainty during the debrief.
