import copy
import csv
import io
import json
import unittest
from exporter import export_orders

class ExportProtectedTests(unittest.TestCase):
    def test_escaping_and_order(self):
        rows=[{"order_id":'a,"b\nc',"status":"paid","amount_cents":1},{"order_id":"é","status":"paid","amount_cents":2}]
        parsed=list(csv.reader(io.StringIO(export_orders(iter(rows)))))
        self.assertEqual(parsed,[['order_id','status','amount_cents'],['a,"b\nc','paid','1'],['é','paid','2']])
    def test_json_has_only_public_fields(self):
        row={"order_id":"é","status":"paid","amount_cents":0,"internal_note":"secret"}
        original=copy.deepcopy(row)
        output=export_orders(iter([row]),'jsonl',status='paid')
        self.assertEqual(output, '{"amount_cents":0,"order_id":"\\u00e9","status":"paid"}\n')
        self.assertEqual(row,original)
    def test_empty_and_unknown_filter(self):
        self.assertEqual(export_orders([], 'csv'), 'order_id,status,amount_cents\n')
        self.assertEqual(export_orders([], 'jsonl'), '')
        self.assertEqual(export_orders([{"order_id":"x","status":"paid","amount_cents":1}], 'jsonl',status='absent'), '')
    def test_unsupported_format_before_consumption(self):
        def forbidden():
            raise AssertionError('input must not be consumed')
            yield
        with self.assertRaises(ValueError): export_orders(forbidden(),'xml')

if __name__ == '__main__': unittest.main()
