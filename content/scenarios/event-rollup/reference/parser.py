import json
from datetime import datetime, timezone

def read_events(lines):
    for number,line in enumerate(lines,1):
        if not line.strip():
            continue
        try:
            row=json.loads(line)
            if not isinstance(row,dict):
                raise ValueError("event must be an object")
            for key in ("event_id","customer_id"):
                if not isinstance(row.get(key),str) or not row[key].strip():
                    raise ValueError(f"invalid {key}")
            if row.get("kind") not in ("purchase","refund"):
                raise ValueError("invalid kind")
            if type(row.get("amount_cents")) is not int or row["amount_cents"] <= 0:
                raise ValueError("invalid amount_cents")
            stamp=row.get("occurred_at")
            if not isinstance(stamp,str):
                raise ValueError("invalid occurred_at")
            occurred=datetime.fromisoformat(stamp)
            if occurred.tzinfo is None or occurred.utcoffset() is None:
                raise ValueError("timezone required")
            yield {"event_id":row["event_id"],"customer_id":row["customer_id"],"kind":row["kind"],"amount_cents":row["amount_cents"],"occurred_at":occurred.astimezone(timezone.utc)}
        except (ValueError,TypeError,KeyError) as error:
            raise ValueError(f"line {number}: invalid event") from error
