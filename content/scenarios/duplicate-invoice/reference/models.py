from dataclasses import dataclass


@dataclass(frozen=True)
class PaymentEvent:
    merchant_id: str
    event_id: str
    amount_cents: int
