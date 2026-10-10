class Inventory:
    def __init__(self, stock):
        self.stock = stock

    def available(self, sku):
        return self.stock.get(sku)

    def reserve(self, sku, quantity):
        if self.stock.get(sku, 0) < quantity:
            return False
        self.stock[sku] = self.stock.get(sku, 0) - quantity
        return True
