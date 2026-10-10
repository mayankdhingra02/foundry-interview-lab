import unittest
from models import LineItem
from quote import quote_total

class QuoteProtectedTests(unittest.TestCase):
    def test_round_once_not_per_line(self):
        self.assertEqual(quote_total([LineItem(1, 1), LineItem(1, 1)], 5000), 1)
    def test_invalid_numeric_values(self):
        for value in [True, False, 1.0, '1', None, -1]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): quote_total([LineItem(value, 1)])
        for value in [True, 0, 1.5, '2', -2]:
            with self.assertRaises(ValueError): quote_total([LineItem(10, value)])
    def test_invalid_parameters(self):
        for discount in [True, -1, 10001, 0.5, '100']:
            with self.assertRaises(ValueError): quote_total([], discount)
        for shipping in [True, -1, 0.5, '1']:
            with self.assertRaises(ValueError): quote_total([], shipping_cents=shipping)
    def test_large_amount_exact(self):
        value = 9007199254740993
        self.assertEqual(quote_total([LineItem(value, 3)], 3333), (value*3*6667+5000)//10000)
    def test_one_pass_and_full_discount(self):
        self.assertEqual(quote_total(iter([LineItem(0, 2), LineItem(3, 3)]), 10000, 8), 8)
        self.assertIs(type(quote_total([LineItem(0, 1)])), int)

if __name__ == '__main__': unittest.main()
