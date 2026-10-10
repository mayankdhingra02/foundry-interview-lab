from models import LineItem

def quote_total(lines, discount_bps=0, shipping_cents=0):
    """Return integer cents after one invoice-level discount, then shipping."""
    subtotal = sum(line.unit_cents * line.quantity for line in lines)
    return round(subtotal * (1 - discount_bps / 10000)) + shipping_cents
