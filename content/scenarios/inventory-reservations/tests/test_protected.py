import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from inventory import InventoryStore

class InventoryProtectedTests(unittest.TestCase):
    def test_concurrent_invariant(self):
        with tempfile.TemporaryDirectory() as folder:
            path=os.path.join(folder,'stock.db')
            setup=InventoryStore(path)
            setup.seed('limited',5)
            setup.close()
            barrier=threading.Barrier(16)
            def worker(_):
                store=InventoryStore(path)
                try:
                    barrier.wait(timeout=5)
                    return store.reserve('limited',1)
                finally: store.close()
            with ThreadPoolExecutor(max_workers=16) as pool:
                accepted=list(pool.map(worker,range(16)))
            check=InventoryStore(path)
            try:
                self.assertEqual(sum(accepted),5)
                self.assertEqual(check.available('limited'),0)
            finally: check.close()
    def test_invalid_and_independent_skus(self):
        store=InventoryStore()
        self.addCleanup(store.close)
        store.seed('a',4)
        store.seed('b',2)
        for quantity in [True,False,0,-1,1.5,'1']:
            with self.assertRaises(ValueError): store.reserve('a',quantity)
        for sku in ['', '  ',None,1]:
            with self.assertRaises(ValueError): store.reserve(sku,1)
        self.assertTrue(store.reserve('a',4))
        self.assertEqual(store.available('a'),0)
        self.assertEqual(store.available('b'),2)
        self.assertFalse(store.reserve('a',1))
    def test_variable_quantity_and_reopen(self):
        with tempfile.TemporaryDirectory() as folder:
            path=os.path.join(folder,'stock.db')
            first=InventoryStore(path)
            first.seed('a',7)
            self.assertTrue(first.reserve('a',3))
            first.close()
            second=InventoryStore(path)
            try:
                self.assertFalse(second.reserve('a',5))
                self.assertTrue(second.reserve('a',4))
                self.assertEqual(second.available('a'),0)
            finally: second.close()

if __name__ == '__main__': unittest.main()
