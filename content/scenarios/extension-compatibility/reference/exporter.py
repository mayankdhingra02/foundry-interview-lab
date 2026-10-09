import csv
import io
import json

FIELDS = ("order_id", "status", "amount_cents")

def export_orders(orders, format="csv", *, status=None):
    if format not in ("csv", "jsonl"):
        raise ValueError("unsupported format")
    selected = (order for order in orders if status is None or order["status"] == status)
    if format == "jsonl":
        return "".join(json.dumps({key: row[key] for key in FIELDS}, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n" for row in selected)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(FIELDS)
    for row in selected:
        writer.writerow([row[field] for field in FIELDS])
    return stream.getvalue()
