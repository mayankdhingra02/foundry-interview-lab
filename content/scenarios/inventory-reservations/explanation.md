# Author explanation

The reference validates the request and performs one conditional UPDATE: decrement only where the matching SKU has enough stock. SQLite coordinates the write across connections; rowcount is the success result. No stale count is written back. This is a bounded reservation example, not a full stock ledger, reservation expiry, or cross-service checkout design.

This is one valid reference approach; equivalent solutions should receive equivalent credit. Passing these checks does not establish production readiness or prove the learner understood the solution.
