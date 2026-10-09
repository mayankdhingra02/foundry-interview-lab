import concurrent.futures
import os
import tempfile
import threading
import unittest
from inventory import ReservationStore

class ProtectedChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.directory.name, 'stock.db')
        self.store = ReservationStore(self.path)
        self.store.seed('a', 5)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def parallel(self, count, action):
        barrier = threading.Barrier(count)
        def run(index):
            connection = ReservationStore(self.path)
            try:
                barrier.wait(timeout=5)
                return action(connection, index)
            finally: connection.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
            return list(pool.map(run, range(count)))

    def test_concurrent_unique_reserves(self):
        results = self.parallel(8, lambda db, i: db.reserve('r'+str(i), 'a', 1))
        self.assertEqual(sum(results), 5)
        self.assertEqual(self.store.available('a'), 0)
        for i, accepted in enumerate(results):
            self.assertEqual(self.store.cancel('r'+str(i)), accepted)
        self.assertEqual(self.store.available('a'), 5)

    def test_concurrent_same_request(self):
        self.assertEqual(self.parallel(6, lambda db, _: db.reserve('same', 'a', 2)), [True]*6)
        self.assertEqual(self.store.available('a'), 3)
        results = self.parallel(6, lambda db, _: db.cancel('same'))
        self.assertEqual(sum(results), 1)
        self.assertEqual(self.store.available('a'), 5)

    def test_cancel_persistence_and_conflict(self):
        self.store.reserve('r1', 'a', 2)
        self.store.cancel('r1')
        self.store.close()
        self.store = ReservationStore(self.path)
        self.assertTrue(self.store.reserve('r1', 'a', 2))
        self.assertFalse(self.store.cancel('r1'))
        with self.assertRaises(ValueError): self.store.reserve('r1', 'a', 1)
        self.assertEqual(self.store.available('a'), 5)

    def test_validation_and_rejected_conflict(self):
        for value in [True, 0, -1, None, '1', 1.2]:
            with self.subTest(value=value), self.assertRaises(ValueError): self.store.reserve('bad', 'a', value)
        for value in ['', ' ', None, 2]:
            with self.subTest(value=value), self.assertRaises(ValueError): self.store.cancel(value)
        self.assertFalse(self.store.reserve('denied', 'a', 6))
        with self.assertRaises(ValueError): self.store.reserve('denied', 'a', 1)
        self.assertEqual(self.store.available('a'), 5)
