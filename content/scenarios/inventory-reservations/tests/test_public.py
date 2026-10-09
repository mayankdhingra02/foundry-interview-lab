import unittest
from inventory import InventoryStore

class InventoryPublicTests(unittest.TestCase):
    def setUp(self):
        self.store=InventoryStore()
        self.addCleanup(self.store.close)
        self.store.seed('book',5)
    def test_success_and_exhaustion(self):
        self.assertTrue(self.store.reserve('book',3))
        self.assertFalse(self.store.reserve('book',3))
        self.assertEqual(self.store.available('book'),2)
    def test_missing(self):
        self.assertFalse(self.store.reserve('missing',1))
    def test_invalid_quantity(self):
        with self.assertRaises(ValueError): self.store.reserve('book',-1)
        self.assertEqual(self.store.available('book'),5)

if __name__ == '__main__': unittest.main()
