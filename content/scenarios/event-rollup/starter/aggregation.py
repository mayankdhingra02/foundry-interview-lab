def aggregate(events):
    totals={}
    for event in events:
        key=(event["customer_id"],event["occurred_at"].date().isoformat())
        totals[key]=totals.get(key,0)+event["amount_cents"]
    return [{"customer_id":customer,"day":day,"net_cents":amount} for (customer,day),amount in sorted(totals.items())]
