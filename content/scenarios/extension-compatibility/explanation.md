# Author explanation

The reference validates the format first and uses one shared filtered generator. CSV stays on the standard-library writer. JSONL explicitly selects public fields and specifies deterministic separators, key order, and ASCII escaping. No arbitrary mapping properties become part of the exported contract.

This is one valid reference approach; equivalent solutions should receive equivalent credit. Passing these checks does not establish production readiness or prove the learner understood the solution.
