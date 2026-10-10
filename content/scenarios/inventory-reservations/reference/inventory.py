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
        if not isinstance(sku,str) or not sku.strip():
            raise ValueError("sku must be non-empty")
        if type(quantity) is not int or quantity <= 0:
            raise ValueError("quantity must be a positive integer")
        with self.db:
            cursor=self.db.execute("UPDATE stock SET available=available-? WHERE sku=? AND available>=?",(quantity,sku,quantity))
        return cursor.rowcount == 1
