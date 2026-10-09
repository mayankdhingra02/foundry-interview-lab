import os
import tempfile
import unittest
from inventory import RetryInventory

class PublicChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.directory.name, 'stock.db')
        self.store = RetryInventory(self.path)
        self.store.seed('a', 5)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def test_identical_retry(self):
        self.assertTrue(self.store.reserve('r1', 'a', 2))
        self.assertTrue(self.store.reserve('r1', 'a', 2))
        self.assertEqual(self.store.available('a'), 3)

    def test_payload_conflict(self):
        self.store.reserve('r1', 'a', 1)
        with self.assertRaises(ValueError): self.store.reserve('r1', 'a', 2)
        self.assertEqual(self.store.available('a'), 4)

    def test_failure_state(self):
        self.assertFalse(self.store.reserve('r1', 'a', 6))
        self.assertFalse(self.store.reserve('r2', 'missing', 1))
        self.assertEqual(self.store.available('a'), 5)

    def test_reopen(self):
        self.store.reserve('r1', 'a', 2)
        self.store.close()
        self.store = RetryInventory(self.path)
        self.assertTrue(self.store.reserve('r1', 'a', 2))
        self.assertEqual(self.store.available('a'), 3)
