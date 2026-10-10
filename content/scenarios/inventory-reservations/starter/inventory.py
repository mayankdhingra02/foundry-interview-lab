import sqlite3

class InventoryStore:
    def __init__(self, path=":memory:"):
        self.db=sqlite3.connect(path,timeout=10)
        self.db.execute("CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, available INTEGER NOT NULL)")
        self.db.commit()
    def seed(self, sku, quantity):
        with self.db:
            self.db.execute("INSERT INTO stock (sku, available) VALUES (?, ?)",(sku,quantity))
    def available(self, sku):
        row=self.db.execute("SELECT available FROM stock WHERE sku=?",(sku,)).fetchone()
        return None if row is None else row[0]
    def close(self):
        self.db.close()

    def reserve(self, sku, quantity):
        """Return True when the stock reservation succeeded."""
        current=self.available(sku)
        if current is None or current < quantity:
            return False
        with self.db:
            self.db.execute("UPDATE stock SET available=? WHERE sku=?",(current-quantity,sku))
        return True
