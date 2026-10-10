# A quote that loses a cent

Fix integer monetary calculations and validate an invoice quote without changing its API. Preserve the documented public interface. Use only Python 3.11 standard-library modules.

## Requirements

- Keep quote_total(lines, discount_bps=0, shipping_cents=0) and return an integer number of cents.
- Each LineItem has an integer unit_cents >= 0 and integer quantity >= 1; booleans, floats, and strings are invalid.
- discount_bps must be an integer from 0 through 10000; shipping_cents must be an integer >= 0. Booleans are invalid.
- Compute the subtotal, apply the discount once at invoice level, round half up to cents, then add undiscounted shipping. Avoid floating-point arithmetic.
- Empty inputs are valid and return shipping; accept a one-pass iterable without mutating its items. Raise ValueError for invalid values.

## Working agreement

Inspect the modules, implement the requirements, and verify the behavior with tests. Public checks illustrate the contract; protected checks cover the same disclosed contract, not new requirements. You may add your own tests. No network or external dependencies are needed. Explain your assumptions and any remaining uncertainty during the debrief.
