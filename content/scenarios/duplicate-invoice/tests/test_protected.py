import os
import tempfile
import unittest
from models import PaymentEvent
from service import create_invoice
from store import InvoiceStore

class InvoiceProtectedTests(unittest.TestCase):
    def test_invalid_events_do_not_write(self):
        store=InvoiceStore()
        self.addCleanup(store.close)
        for event in [PaymentEvent('', 'x',1),PaymentEvent('  ','x',1),PaymentEvent('a',None,1),PaymentEvent(None,'x',1),PaymentEvent('a','x',True),PaymentEvent('a','x',1.5),PaymentEvent('a','x',0),PaymentEvent('a','x',-1)]:
            with self.subTest(event=event):
                with self.assertRaises(ValueError): create_invoice(store,event)
        self.assertEqual(store.all(),[])
    def test_restart_and_distinct_delivery(self):
        with tempfile.TemporaryDirectory() as folder:
            path=os.path.join(folder,'invoice.db')
            store=InvoiceStore(path)
            first=create_invoice(store,PaymentEvent('a','x',10))
            store.close()
            reopened=InvoiceStore(path)
            self.addCleanup(reopened.close)
            self.assertEqual(create_invoice(reopened,PaymentEvent('a','x',10)),first)
            self.assertNotEqual(create_invoice(reopened,PaymentEvent('a','y',10)),first)
            self.assertEqual(len(reopened.all()),2)
    def test_conflict_does_not_poison_connection(self):
        store=InvoiceStore()
        self.addCleanup(store.close)
        create_invoice(store,PaymentEvent('a','x',10))
        with self.assertRaises(ValueError): create_invoice(store,PaymentEvent('a','x',12))
        create_invoice(store,PaymentEvent('a','next',12))
        self.assertEqual(len(store.all()),2)

if __name__ == '__main__': unittest.main()
