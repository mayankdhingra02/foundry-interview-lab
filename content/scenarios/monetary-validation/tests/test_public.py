import unittest
from models import LineItem
from quote import quote_total

class QuotePublicTests(unittest.TestCase):
    def test_ordinary_quote(self):
        self.assertEqual(quote_total([LineItem(100, 2)], 1000, 25), 205)
    def test_half_up(self):
        self.assertEqual(quote_total([LineItem(1, 1)], 5000), 1)
    def test_negative_quantity(self):
        with self.assertRaises(ValueError): quote_total([LineItem(100, -1)])
    def test_empty(self):
        self.assertEqual(quote_total([], shipping_cents=40), 40)

if __name__ == '__main__': unittest.main()
