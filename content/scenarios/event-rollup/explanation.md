# Author explanation

The reference parser validates each physical line and normalizes timezone-aware datetimes to UTC. Aggregation tracks semantic event identity, signs refunds, retains zero and negative totals, and emits deterministic sorted rows. Deduplication uses memory proportional to distinct events; an unbounded production stream would need a bounded retention or durable identity design.

This is one valid reference approach; equivalent solutions should receive equivalent credit. Passing these checks does not establish production readiness or prove the learner understood the solution.
