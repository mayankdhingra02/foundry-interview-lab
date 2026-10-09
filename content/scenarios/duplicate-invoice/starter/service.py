from models import PaymentEvent
from store import InvoiceStore

def create_invoice(store: InvoiceStore, event: PaymentEvent) -> int:
    """Return the invoice ID for this delivery, including retries."""
    return store.insert(event)
