import sqlite3
from models import PaymentEvent


class InvoiceStore:
    def __init__(self, path=":memory:"):
        self.db = sqlite3.connect(path, timeout=5)
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                merchant_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                UNIQUE (merchant_id, event_id)
            )
        """)
        self.db.commit()

    def insert(self, event: PaymentEvent) -> int:
        with self.db:
            self.db.execute(
                """INSERT INTO invoices (merchant_id, event_id, amount_cents)
                   VALUES (?, ?, ?) ON CONFLICT (merchant_id, event_id) DO NOTHING""",
                (event.merchant_id, event.event_id, event.amount_cents),
            )
            invoice_id, amount = self.db.execute(
                "SELECT id, amount_cents FROM invoices WHERE merchant_id = ? AND event_id = ?",
                (event.merchant_id, event.event_id),
            ).fetchone()
            if amount != event.amount_cents:
                raise ValueError("delivery key reused with a different amount")
        return invoice_id

    def all(self):
        return self.db.execute(
            "SELECT id, merchant_id, event_id, amount_cents FROM invoices ORDER BY id"
        ).fetchall()

    def close(self):
        self.db.close()
