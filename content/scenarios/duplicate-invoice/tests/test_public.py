import unittest
from models import PaymentEvent
from service import create_invoice
from store import InvoiceStore

class InvoicePublicTests(unittest.TestCase):
    def setUp(self):
        self.store=InvoiceStore()
        self.addCleanup(self.store.close)
    def test_identical_retry(self):
        event=PaymentEvent('a','x',10)
        first=create_invoice(self.store,event)
        self.assertEqual(create_invoice(self.store,event),first)
        self.assertEqual(len(self.store.all()),1)
    def test_merchant_scope(self):
        self.assertNotEqual(create_invoice(self.store,PaymentEvent('a','x',10)),create_invoice(self.store,PaymentEvent('b','x',10)))
    def test_conflicting_amount(self):
        create_invoice(self.store,PaymentEvent('a','x',10))
        with self.assertRaises(ValueError): create_invoice(self.store,PaymentEvent('a','x',11))
        self.assertEqual(self.store.all()[0][3],10)

if __name__ == '__main__': unittest.main()
