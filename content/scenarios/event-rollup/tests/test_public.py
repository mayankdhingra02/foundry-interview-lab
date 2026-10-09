import json
import unittest
from pipeline import build_report

def event(id,kind='purchase',amount=100,time='2026-01-02T00:30:00+02:00',customer='a'):
    return json.dumps({'event_id':id,'customer_id':customer,'kind':kind,'amount_cents':amount,'occurred_at':time})
class RollupPublicTests(unittest.TestCase):
    def test_utc_day(self):
        self.assertEqual(build_report([event('1')]),[{'customer_id':'a','day':'2026-01-01','net_cents':100}])
    def test_refund_and_retry(self):
        purchase=event('1',time='2026-01-01T10:00:00+00:00')
        refund=event('2','refund',30,time='2026-01-01T11:00:00+00:00')
        self.assertEqual(build_report([purchase,purchase,refund]),[{'customer_id':'a','day':'2026-01-01','net_cents':70}])
    def test_empty(self):
        self.assertEqual(build_report(iter(['','  '])),[])

if __name__ == '__main__': unittest.main()
