import json
from datetime import datetime

def read_events(lines):
    for line in lines:
        if line.strip():
            row=json.loads(line)
            row["occurred_at"]=datetime.fromisoformat(row["occurred_at"])
            yield row
