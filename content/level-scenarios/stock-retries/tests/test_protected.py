import unittest
from inventory import RetryInventory

class ProtectedChecks(unittest.TestCase):
    def setUp(self):
        self.store = RetryInventory()
        self.store.seed('a', 3)
        self.store.seed('b', 4)

    def tearDown(self): self.store.close()

    def test_rejected_identity_conflict(self):
        self.assertFalse(self.store.reserve('denied', 'a', 4))
        with self.assertRaises(ValueError): self.store.reserve('denied', 'a', 2)
        self.assertEqual(self.store.available('a'), 3)

    def test_sku_conflict(self):
        self.store.reserve('r1', 'a', 1)
        with self.assertRaises(ValueError): self.store.reserve('r1', 'b', 1)
        self.assertEqual(self.store.available('a'), 2)
        self.assertEqual(self.store.available('b'), 4)

    def test_invalid_inputs_do_not_claim_identity(self):
        for value in [0, -1, True, 1.5, '1', None]:
            with self.subTest(value=value), self.assertRaises(ValueError): self.store.reserve('r1', 'a', value)
        for value in ['', ' ', None, 2]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): self.store.reserve(value, 'a', 1)
                with self.assertRaises(ValueError): self.store.reserve('r1', value, 1)
        self.assertTrue(self.store.reserve('r1', 'a', 1))
        self.assertEqual(self.store.available('a'), 2)

    def test_exact_identity_text(self):
        self.assertTrue(self.store.reserve(' r1 ', 'a', 1))
        self.assertTrue(self.store.reserve('r1', 'a', 1))
        self.assertTrue(self.store.reserve(' r1 ', 'a', 1))
        self.assertEqual(self.store.available('a'), 1)
