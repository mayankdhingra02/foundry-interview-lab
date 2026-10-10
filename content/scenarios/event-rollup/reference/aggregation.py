def aggregate(events):
    seen={}
    totals={}
    for event in events:
        identity=event["event_id"]
        payload=(event["customer_id"],event["kind"],event["amount_cents"],event["occurred_at"])
        if identity in seen:
            if seen[identity] != payload:
                raise ValueError("conflicting event_id")
            continue
        seen[identity]=payload
        key=(event["customer_id"],event["occurred_at"].date().isoformat())
        signed=event["amount_cents"] if event["kind"] == "purchase" else -event["amount_cents"]
        totals[key]=totals.get(key,0)+signed
    return [{"customer_id":customer,"day":day,"net_cents":amount} for (customer,day),amount in sorted(totals.items())]
