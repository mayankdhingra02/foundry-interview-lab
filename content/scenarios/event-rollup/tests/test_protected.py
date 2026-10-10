import json
import unittest
from pipeline import build_report

def record(id='x',customer='a',kind='purchase',amount=10,time='2026-01-01T00:00:00+00:00'):
    return json.dumps({'event_id':id,'customer_id':customer,'kind':kind,'amount_cents':amount,'occurred_at':time})
class RollupProtectedTests(unittest.TestCase):
    def test_equivalent_instants_and_order(self):
        result=build_report(iter([record('b','z'),record('a','a',time='2025-12-31T19:00:00-05:00'),record('a','a'),record('c','a','refund',10)]))
        self.assertEqual(result,[{'customer_id':'a','day':'2026-01-01','net_cents':0},{'customer_id':'z','day':'2026-01-01','net_cents':10}])
    def test_conflicting_event(self):
        with self.assertRaises(ValueError): build_report([record(),record(amount=11)])
        with self.assertRaises(ValueError): build_report([record(),record(customer='b')])
    def test_line_number_and_validation(self):
        bads=['{','[]',record(time='2026-01-01T00:00:00'),record(amount=True),record(amount=0),record(customer=' '),record(kind='other')]
        for bad in bads:
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(ValueError,r'line 3\b'): build_report(['',record('ok'),bad])
    def test_refund_only_negative_and_day_sort(self):
        self.assertEqual(build_report([record('r',kind='refund',amount=3,time='2026-01-03T00:00:00+00:00'),record('p',amount=2)]),[{'customer_id':'a','day':'2026-01-01','net_cents':2},{'customer_id':'a','day':'2026-01-03','net_cents':-3}])

if __name__ == '__main__': unittest.main()
