import unittest
from inventory import Inventory

class PublicChecks(unittest.TestCase):
    def test_count_conservation(self):
        store = Inventory({'a': 5})
        self.assertTrue(store.reserve('a', 2))
        self.assertEqual(store.available('a'), 3)
        self.assertFalse(store.reserve('a', 4))
        self.assertEqual(store.available('a'), 3)

    def test_missing_and_zero(self):
        store = Inventory({'a': 0})
        self.assertIsNone(store.available('missing'))
        self.assertFalse(store.reserve('missing', 1))
        self.assertFalse(store.reserve('a', 1))
        self.assertEqual(store.available('a'), 0)

    def test_invalid_quantity(self):
        store = Inventory({'a': 3})
        for value in [-1, 0, True, False, 1.5, '1', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                store.reserve('a', value)
        self.assertEqual(store.available('a'), 3)

    def test_caller_ownership(self):
        original = {'a': 3}
        store = Inventory(original)
        store.reserve('a', 1)
        self.assertEqual(original, {'a': 3})
        original['a'] = 99
        self.assertEqual(store.available('a'), 2)
