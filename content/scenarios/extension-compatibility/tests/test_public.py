import unittest
from exporter import export_orders

ROWS = [{"order_id":"o-1","status":"paid","amount_cents":120},{"order_id":"o-2","status":"open","amount_cents":30}]
class ExportPublicTests(unittest.TestCase):
    def test_legacy_csv(self):
        self.assertEqual(export_orders(ROWS), 'order_id,status,amount_cents\no-1,paid,120\no-2,open,30\n')
    def test_filter_csv(self):
        self.assertEqual(export_orders(ROWS,status='paid'), 'order_id,status,amount_cents\no-1,paid,120\n')
    def test_jsonl(self):
        self.assertEqual(export_orders(ROWS[:1],'jsonl'), '{"amount_cents":120,"order_id":"o-1","status":"paid"}\n')

if __name__ == '__main__': unittest.main()
