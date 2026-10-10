# One retry, one debit

Implement RetryInventory(path), seed(sku, quantity), available(sku), reserve(request_id, sku, quantity), close(). Mid-level preparation draft; human calibration pending. Prerequisites: basic SQL transactions, explicit error semantics and the distinction between retry identity and payload identity.

Use SQLite with durable state across reopen. seed is a one-time pre-request fixture: insert a non-empty string SKU with an exact integer count >= 0; concurrent reseeding is outside scope. All public SKU arguments are non-empty strings; preserve exact text. request_id is a non-empty string. Reservation quantities are exact integers > 0; bool is invalid. Validate before mutation, raising ValueError for malformed values.

A new request returns True and decrements stock if available; missing/insufficient stock returns False unchanged. Persist both outcomes. Repeating the same request ID and exact (sku, quantity) returns its original bool without another debit. Reusing the ID with a different payload raises ValueError with no state change, including after reopen. Store the outcome and stock update atomically so an exception/rollback cannot leave only one recorded. Each object owns its connection. Concurrent requests are outside this Mid-level contract; explain the limitation.

Public and protected checks cover only this contract. Learner regression checks are additive and cannot replace protected checks. Same stock-family variants are repeated-domain practice, not unseen retests.
