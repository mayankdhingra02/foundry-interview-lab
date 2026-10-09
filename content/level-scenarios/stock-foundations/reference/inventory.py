class Inventory:
    @staticmethod
    def _sku(sku):
        if not isinstance(sku, str) or not sku.strip():
            raise ValueError('sku must be non-empty')

    def __init__(self, stock):
        if not hasattr(stock, 'items'):
            raise ValueError('stock must be a mapping')
        copied = {}
        for sku, quantity in stock.items():
            self._sku(sku)
            if type(quantity) is not int or quantity < 0:
                raise ValueError('stock must contain non-negative exact integers')
            copied[sku] = quantity
        self.stock = copied

    def available(self, sku):
        self._sku(sku)
        return self.stock.get(sku)

    def reserve(self, sku, quantity):
        self._sku(sku)
        if type(quantity) is not int or quantity <= 0:
            raise ValueError('quantity must be a positive exact integer')
        available = self.stock.get(sku)
        if available is None or available < quantity:
            return False
        self.stock[sku] -= quantity
        return True
