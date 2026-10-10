from parser import read_events
from aggregation import aggregate

def build_report(lines):
    """Turn a one-pass iterable of JSON lines into daily customer totals."""
    return aggregate(read_events(lines))
