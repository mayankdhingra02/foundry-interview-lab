# The last five units

Prevent overselling when independent workers reserve stock concurrently. Preserve the documented public interface. Use only Python 3.11 standard-library modules.

## Requirements

- Preserve InventoryStore methods __init__, seed, available, reserve, and close. seed is an administrative fixture used before requests; it need not support concurrent reseeding.
- reserve(sku, quantity) returns True exactly when stock was reduced by that quantity; otherwise returns False with no stock change for a missing SKU or insufficient stock.
- Across independent SQLite connections to one database, total successful reserved quantity must never exceed seeded stock, and remaining stock must match the successful reservations.
- Reject non-string/whitespace-only SKU and non-positive/non-integer quantity with ValueError before any change. Booleans are invalid quantities.
- Use durable database coordination, not a process-local lock. The same database must retain remaining stock after reopening. Each worker owns its connection; do not share SQLite connections between threads.

## Working agreement

Inspect the modules, implement the requirements, and verify the behavior with tests. Public checks illustrate the contract; protected checks cover the same disclosed contract, not new requirements. You may add your own tests. No network or external dependencies are needed. Explain your assumptions and any remaining uncertainty during the debrief.
