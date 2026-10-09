const { fail } = require("./security");
const { array } = require("./order-view");
const { totals } = require("./commerce");

function paise(value) {
  const n = Number(value),
    result = Math.round(n * 100);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(result))
    throw fail(409, "The saved bill needs review before a refund.");
  return result;
}

// Allocate the original paid total across individual units, including the saved
// discount and tax. Cumulative integer division makes every partial refund add
// up to exactly the captured amount, without floating-point rounding drift.
function refundableLines(order, payment, refunds) {
  const paid = paise(payment.amount);
  if (paid !== paise(totals(order).total))
    throw fail(
      409,
      "The captured payment does not match this bill. Review it before refunding.",
    );
  const items = array(order.items);
  const gross = items.map((item) => {
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 100
    )
      throw fail(409, "The saved item quantities need review before a refund.");
    return paise(item.price ?? item.cart_item_price);
  });
  const subtotal = items.reduce(
    (sum, item, i) => sum + gross[i] * item.quantity,
    0,
  );
  if (!items.length || subtotal <= 0 || subtotal !== paise(order.total_price))
    throw fail(
      409,
      "The saved items do not match this bill. Review it before refunding.",
    );
  const used = new Map();
  for (const refund of refunds.filter((r) => r.status !== "failed")) {
    for (const item of array(refund.items))
      used.set(
        item.line_index,
        (used.get(item.line_index) || 0) + item.quantity,
      );
  }
  let cumulative = 0;
  const share = (value) =>
    Number((BigInt(paid) * BigInt(value)) / BigInt(subtotal));
  return items.map((item, line_index) => {
    const taken = used.get(line_index) || 0;
    if (taken > item.quantity)
      throw fail(409, "The refund history needs review.");
    const unitAmounts = [];
    for (let unit = 0; unit < item.quantity; unit++) {
      const amount = share(cumulative + gross[line_index]) - share(cumulative);
      cumulative += gross[line_index];
      if (unit >= taken) unitAmounts.push(amount);
    }
    return {
      line_index,
      name: item.name || item.item_name || item.cart_item_name || "Menu item",
      quantity: item.quantity,
      remaining_quantity: item.quantity - taken,
      unit_amounts_paise: unitAmounts,
    };
  });
}

function refundSelection(lines, input) {
  const selected =
    input.kind === "full"
      ? lines
          .filter((l) => l.remaining_quantity)
          .map((l) => ({
            line_index: l.line_index,
            quantity: l.remaining_quantity,
          }))
      : input.items;
  let amount = 0;
  const items = selected.map((item) => {
    const line = lines[item.line_index];
    if (!line || item.quantity > line.remaining_quantity)
      throw fail(
        409,
        "Some selected items have already been refunded. Refresh the order.",
      );
    const amount_paise = line.unit_amounts_paise
      .slice(0, item.quantity)
      .reduce((a, b) => a + b, 0);
    amount += amount_paise;
    return {
      line_index: item.line_index,
      quantity: item.quantity,
      name: line.name,
      amount_paise,
    };
  });
  if (!Number.isSafeInteger(amount) || amount < 100)
    throw fail(400, "Select items worth at least ₹1 to refund.");
  return { items, amount };
}
module.exports = { paise, refundableLines, refundSelection };
