# An export API with existing customers

Add JSONL export and filtering while preserving every documented CSV behavior. Preserve the documented public interface. Use only Python 3.11 standard-library modules.

## Requirements

- Preserve export_orders(orders, format="csv", *, status=None). orders is a one-pass iterable of mappings with order_id, status, and integer amount_cents.
- Default CSV must keep header order order_id,status,amount_cents, input row order, standard CSV quoting, LF row endings, and a trailing newline. Empty CSV contains its header.
- Add format="jsonl": one compact JSON object per selected row with exactly the three public fields, keys sorted lexically, ensure_ascii=True, and a trailing newline. Empty JSONL is an empty string.
- If status is given, include rows with exactly that status in both formats; status=None includes all rows. Unknown statuses simply produce no rows.
- Do not mutate inputs or consume the iterable twice. Reject an unsupported format with ValueError before iterating inputs.

## Working agreement

Inspect the modules, implement the requirements, and verify the behavior with tests. Public checks illustrate the contract; protected checks cover the same disclosed contract, not new requirements. You may add your own tests. No network or external dependencies are needed. Explain your assumptions and any remaining uncertainty during the debrief.
