# Count every unit

Implement the documented Inventory API in inventory.py. This is a Junior preparation draft, with human difficulty calibration pending. Prerequisite: trace conditionals and write basic assertions (Foundry Correctness lesson, when integration is configured).

Constructor Inventory(stock) accepts a mapping of non-empty string SKUs to exact integer counts >= 0, validates the entire mapping, and owns a copy. available(sku) returns the count or None. reserve(sku, quantity) accepts non-empty string SKU and an exact integer quantity > 0; bool is invalid. Whitespace-only SKUs are invalid but other SKU text is preserved. Invalid input raises ValueError before mutation. Missing/insufficient stock returns False unchanged; successful reservation returns True and decrements exactly once. available also rejects invalid SKUs. No persistence or concurrent callers are required.

Public and protected checks test only these disclosed requirements. Add a learner regression check if useful; it cannot replace protected checks. Same-family variants repeat the stock domain and do not count as unseen transfer evidence.
