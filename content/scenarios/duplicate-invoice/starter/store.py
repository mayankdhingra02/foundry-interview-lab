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
                amount_cents INTEGER NOT NULL
            )
        """)
        self.db.commit()

    def insert(self, event: PaymentEvent) -> int:
        with self.db:
            cursor = self.db.execute(
                "INSERT INTO invoices (merchant_id, event_id, amount_cents) VALUES (?, ?, ?)",
                (event.merchant_id, event.event_id, event.amount_cents),
            )
        return cursor.lastrowid

    def all(self):
        return self.db.execute(
            "SELECT id, merchant_id, event_id, amount_cents FROM invoices ORDER BY id"
        ).fetchall()

    def close(self):
        self.db.close()
