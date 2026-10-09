import csv
import io

FIELDS = ("order_id", "status", "amount_cents")

def export_orders(orders, format="csv", *, status=None):
    """Legacy CSV API; new JSONL and optional status filtering are unfinished."""
    if format != "csv":
        raise ValueError("unsupported format")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(FIELDS)
    for order in orders:
        writer.writerow([order[field] for field in FIELDS])
    return stream.getvalue()
