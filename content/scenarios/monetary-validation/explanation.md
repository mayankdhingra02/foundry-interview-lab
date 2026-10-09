# Author explanation

The reference validates each amount and parameter, consumes the iterable once, and calculates (subtotal * (10000 - discount_bps) + 5000) // 10000 + shipping_cents. This implements half-up rounding for the disclosed nonnegative amounts. Negative monetary adjustments would need a separate signed-rounding contract.

This is one valid reference approach; equivalent solutions should receive equivalent credit. Passing these checks does not establish production readiness or prove the learner understood the solution.
