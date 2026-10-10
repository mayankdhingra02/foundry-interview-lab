from dataclasses import dataclass

@dataclass(frozen=True)
class LineItem:
    unit_cents: int
    quantity: int
