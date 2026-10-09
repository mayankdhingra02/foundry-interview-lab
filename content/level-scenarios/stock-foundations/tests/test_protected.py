import unittest
from inventory import Inventory

class ProtectedChecks(unittest.TestCase):
    def test_invalid_initial_counts(self):
        for value in [-1, True, False, 1.1, '2', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                Inventory({'ok': 2, 'bad': value})

    def test_invalid_sku(self):
        store = Inventory({'a': 3})
        for value in ['', '   ', 2, None]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): store.available(value)
                with self.assertRaises(ValueError): store.reserve(value, 1)
                with self.assertRaises(ValueError): Inventory({value: 2})
        self.assertEqual(store.available('a'), 3)

    def test_exact_text_and_full_depletion(self):
        store = Inventory({' A ': 2, 'A': 4})
        self.assertTrue(store.reserve(' A ', 2))
        self.assertFalse(store.reserve(' A ', 1))
        self.assertEqual(store.available(' A '), 0)
        self.assertEqual(store.available('A'), 4)

    def test_mapping_required(self):
        for value in [None, [], [('a', 2)], 4]:
            with self.subTest(value=value), self.assertRaises(ValueError): Inventory(value)
