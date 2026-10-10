# Author explanation

Adapted from the original Foundry invoice mission. The reference validates input, enforces UNIQUE(merchant_id, event_id), inserts with conflict handling, and reads the stored invoice to compare payload and return its ID. The database owns persistent identity. This exercise does not claim exactly-once behavior for an external payment service.

This is one valid reference approach; equivalent solutions should receive equivalent credit. Passing these checks does not establish production readiness or prove the learner understood the solution.
