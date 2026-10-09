from models import PaymentEvent
from store import InvoiceStore


def create_invoice(store: InvoiceStore, event: PaymentEvent) -> int:
    if not isinstance(event.merchant_id, str) or not event.merchant_id.strip():
        raise ValueError("merchant_id must be non-empty")
    if not isinstance(event.event_id, str) or not event.event_id.strip():
        raise ValueError("event_id must be non-empty")
    if type(event.amount_cents) is not int or event.amount_cents <= 0:
        raise ValueError("amount_cents must be a positive integer")
    return store.insert(event)


