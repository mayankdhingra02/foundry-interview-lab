from models import LineItem

def _integer(value, name, minimum=0, maximum=None):
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f"invalid {name}")

def quote_total(lines, discount_bps=0, shipping_cents=0):
    """Round discounted subtotal to cents once, half up; shipping is undiscounted."""
    _integer(discount_bps, "discount_bps", maximum=10000)
    _integer(shipping_cents, "shipping_cents")
    subtotal = 0
    for line in lines:
        _integer(line.unit_cents, "unit_cents")
        _integer(line.quantity, "quantity", minimum=1)
        subtotal += line.unit_cents * line.quantity
    return (subtotal * (10000 - discount_bps) + 5000) // 10000 + shipping_cents
