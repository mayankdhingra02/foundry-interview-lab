import sqlite3

class RetryInventory:
    def __init__(self, path=':memory:'):
        self.db = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.db.execute('CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, sku TEXT NOT NULL, quantity INTEGER NOT NULL, accepted INTEGER NOT NULL)')

    @staticmethod
    def _text(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError('identifier must be non-empty')

    def seed(self, sku, quantity):
        self._text(sku)
        if type(quantity) is not int or quantity < 0:
            raise ValueError('stock must be a non-negative exact integer')
        self.db.execute('INSERT INTO stock VALUES (?, ?)', (sku, quantity))

    def available(self, sku):
        self._text(sku)
        row = self.db.execute('SELECT quantity FROM stock WHERE sku=?', (sku,)).fetchone()
        return None if row is None else row[0]

    def close(self):
        self.db.close()

    def reserve(self, request_id, sku, quantity):
        self._text(request_id)
        self._text(sku)
        if type(quantity) is not int or quantity <= 0:
            raise ValueError('quantity must be a positive exact integer')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            prior = self.db.execute('SELECT sku, quantity, accepted FROM requests WHERE request_id=?', (request_id,)).fetchone()
            if prior is not None:
                if prior[:2] != (sku, quantity):
                    raise ValueError('request payload conflict')
                result = bool(prior[2])
            else:
                cursor = self.db.execute('UPDATE stock SET quantity=quantity-? WHERE sku=? AND quantity>=?', (quantity, sku, quantity))
                result = cursor.rowcount == 1
                self.db.execute('INSERT INTO requests VALUES (?, ?, ?, ?)', (request_id, sku, quantity, int(result)))
            self.db.execute('COMMIT')
            return result
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
