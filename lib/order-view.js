function array(value) {
  if (Array.isArray(value)) return value;
  try {
    const a = JSON.parse(value);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function orderView(order, menu = []) {
  const names = new Map(menu.map((i) => [i.id, i]));
  const items = (value) =>
    array(value).map((i) => {
      const id = i.id || i.cart_item_id;
      const m = names.get(id);
      return {
        ...i,
        id,
        name:
          i.name ||
          i.cart_item_name ||
          i.item_name ||
          m?.item_name ||
          "Item no longer on menu",
        item_name:
          i.item_name ||
          i.cart_item_name ||
          i.name ||
          m?.item_name ||
          "Item no longer on menu",
        price: Number(i.price ?? i.cart_item_price ?? 0),
        quantity: Number(i.quantity) || 1,
      };
    });
  return {
    ...order,
    items: items(order.items),
    kot_items: order.kot_items ? items(order.kot_items) : null,
  };
}
module.exports = { orderView, array };
