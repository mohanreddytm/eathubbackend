const { randomUUID, createHash } = require("node:crypto");
const { transaction } = require("./commerce");
const { fail } = require("./security");
const { config, provider } = require("./gateway");
const { paise, refundableLines, refundSelection } = require("./refund-amounts");

const unresolved = (r) =>
  ["requested", "unknown", "pending"].includes(r.status);
const captured = (status) => ["Paid", "SUCCESS"].includes(status);

function inputFor(body) {
  if (!body || !["full", "items"].includes(body.kind))
    throw fail(400, "Choose a full refund or select returned items.");
  if (
    typeof body.reason !== "string" ||
    body.reason.trim().length < 3 ||
    body.reason.trim().length > 500
  )
    throw fail(400, "Enter a refund reason between 3 and 500 characters.");
  // Amounts and provider payment IDs must always come from the saved bill.
  if (
    ["amount", "amount_paise", "payment_id", "provider_payment_id"].some(
      (k) => body[k] !== undefined,
    )
  )
    throw fail(400, "Refund amounts are calculated from the saved order.");
  let items = [];
  if (body.kind === "items") {
    if (
      !Array.isArray(body.items) ||
      !body.items.length ||
      body.items.length > 100
    )
      throw fail(400, "Select at least one returned item.");
    const seen = new Set();
    items = body.items
      .map((i) => {
        if (
          !Number.isInteger(i?.line_index) ||
          i.line_index < 0 ||
          !Number.isInteger(i.quantity) ||
          i.quantity < 1 ||
          i.quantity > 100 ||
          seen.has(i.line_index)
        )
          throw fail(400, "Choose valid, unique item quantities.");
        seen.add(i.line_index);
        return { line_index: i.line_index, quantity: i.quantity };
      })
      .sort((a, b) => a.line_index - b.line_index);
  } else if (body.items?.length)
    throw fail(400, "A full refund includes every remaining item.");
  return { kind: body.kind, items, reason: body.reason.trim() };
}

function publicRefund(row, admin = false) {
  return {
    id: row.id,
    amount_paise: row.amount_paise,
    currency: row.currency,
    status: row.status,
    items: row.items,
    created_at: row.created_at,
    processed_at: row.processed_at,
    ...(admin
      ? {
          reason: row.reason,
          requested_by: row.requested_by,
          request_key: row.idempotency_key,
          provider_refund_id: row.provider_refund_id,
          last_error: row.last_error,
        }
      : {}),
  };
}

function registerRefunds(app, pool, security, remote = provider) {
  const lock = (client, tenant) =>
    client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      tenant,
    ]);
  async function records(client, orderId) {
    return (
      await client.query(
        "SELECT * FROM order_refunds WHERE order_id=$1 ORDER BY created_at,id",
        [orderId],
      )
    ).rows;
  }
  async function paymentFor(client, orderId) {
    return (
      await client.query(
        "SELECT * FROM payments WHERE order_id=$1 AND payment_status IN ('Paid','SUCCESS') ORDER BY created_at DESC LIMIT 1",
        [orderId],
      )
    ).rows[0];
  }
  async function summary(orderId, admin) {
    const order = (
      await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])
    ).rows[0];
    if (!order) throw fail(404, "Order not found");
    const payment = await paymentFor(pool, orderId);
    const refunds = await records(pool, orderId);
    const processed = refunds
      .filter((r) => r.status === "processed")
      .reduce((n, r) => n + r.amount_paise, 0);
    const reserved = refunds
      .filter(unresolved)
      .reduce((n, r) => n + r.amount_paise, 0);
    let reason = "",
      lines = [];
    if (!payment || !captured(order.payment_status))
      reason = "This order has no confirmed payment.";
    else if (!["Completed", "Refunded"].includes(order.status))
      reason = "Complete service before refunding this order.";
    else if (
      !payment.provider_order_id ||
      !/^pay_[a-zA-Z0-9]+$/.test(payment.transaction_id || "")
    )
      reason =
        "This payment was collected at the counter. Razorpay can only refund an online payment.";
    else if (!config(order.restaurant_id))
      reason = "Razorpay test refunds are not configured for this restaurant.";
    else if (refunds.some(unresolved))
      reason =
        "A refund is awaiting confirmation. Check its status before starting another.";
    else if (processed >= paise(payment.amount))
      reason = "This order has been fully refunded.";
    if (payment && admin) {
      try {
        lines = refundableLines(order, payment, refunds);
      } catch (e) {
        reason = e.message;
      }
    }
    return {
      order_id: orderId,
      refund_status: order.refund_status,
      paid_amount_paise: payment ? paise(payment.amount) : 0,
      refunded_amount_paise: processed,
      pending_amount_paise: reserved,
      refunds: refunds.map((r) => publicRefund(r, admin)),
      ...(admin
        ? {
            can_refund: !reason,
            unavailable_reason: reason,
            lines,
            mode: "test",
          }
        : {}),
    };
  }
  async function updateTotals(client, row) {
    const refunds = await records(client, row.order_id);
    const payment = (
      await client.query("SELECT * FROM payments WHERE id=$1", [row.payment_id])
    ).rows[0];
    const amount = refunds
      .filter((r) => r.status === "processed")
      .reduce((n, r) => n + r.amount_paise, 0);
    if (amount > paise(payment.amount))
      throw fail(409, "Refund totals exceed the original payment.");
    const status =
      amount === paise(payment.amount)
        ? "Refunded"
        : refunds.some(unresolved)
          ? "Pending"
          : amount
            ? "Partially Refunded"
            : refunds.some((r) => r.status === "failed")
              ? "Failed"
              : "None";
    await client.query(
      "UPDATE payments SET refunded_amount=$1,updated_at=NOW() WHERE id=$2",
      [amount / 100, row.payment_id],
    );
    await client.query(
      "UPDATE orders SET refunded_amount=$1,refund_status=$2,status=CASE WHEN $2='Refunded' THEN 'Refunded' ELSE status END,order_status=CASE WHEN $2='Refunded' THEN 'Refunded' ELSE order_status END,updated_at=NOW() WHERE id=$3",
      [amount / 100, status, row.order_id],
    );
  }
  async function mark(row, status, message) {
    return transaction(pool, async (client) => {
      await lock(client, row.restaurant_id);
      // A late HTTP error must never undo an already delivered provider webhook.
      const result = await client.query(
        "UPDATE order_refunds SET status=$1,last_error=$2,updated_at=NOW() WHERE id=$3 AND status IN ('requested','unknown') RETURNING *",
        [status, message, row.id],
      );
      await updateTotals(client, row);
      return (
        result.rows[0] ||
        (
          await client.query("SELECT * FROM order_refunds WHERE id=$1", [
            row.id,
          ])
        ).rows[0]
      );
    });
  }
  async function applyRemote(row, refund) {
    if (
      !refund ||
      !/^rfnd_[a-zA-Z0-9]+$/.test(refund.id || "") ||
      refund.payment_id !== row.provider_payment_id ||
      refund.amount !== row.amount_paise ||
      refund.currency !== "INR" ||
      !["pending", "processed", "failed"].includes(refund.status)
    )
      throw fail(
        502,
        "The refund response did not match the saved request. Check its status again.",
      );
    return transaction(pool, async (client) => {
      await lock(client, row.restaurant_id);
      const current = (
        await client.query(
          "SELECT * FROM order_refunds WHERE id=$1 FOR UPDATE",
          [row.id],
        )
      ).rows[0];
      if (
        current.provider_refund_id &&
        current.provider_refund_id !== refund.id
      )
        throw fail(
          409,
          "A different provider refund is already linked to this request.",
        );
      // Processed is final. An old pending webhook must not regress a failed one.
      const status =
        current.status === "processed"
          ? "processed"
          : current.status === "failed" && refund.status === "pending"
            ? "failed"
            : refund.status;
      const result = await client.query(
        "UPDATE order_refunds SET provider_refund_id=$1,status=$2,last_error=$3,processed_at=CASE WHEN $2='processed' THEN COALESCE(processed_at,NOW()) ELSE processed_at END,updated_at=NOW() WHERE id=$4 RETURNING *",
        [
          refund.id,
          status,
          status === "failed"
            ? "Razorpay could not process this refund. Review the payment before trying again."
            : null,
          row.id,
        ],
      );
      await updateTotals(client, row);
      return result.rows[0];
    });
  }
  async function submit(row, replay) {
    const settings = config(row.restaurant_id);
    if (!settings)
      throw fail(
        409,
        "Razorpay test refunds are not configured for this restaurant.",
      );
    if (row.status === "processed" || row.status === "failed") return row;
    let attempted = replay;
    try {
      if (row.provider_refund_id) {
        const refund = await remote(
          `/payments/${row.provider_payment_id}/refunds/${row.provider_refund_id}`,
          settings,
        );
        return await applyRemote(row, refund);
      }
      const payment = (
        await pool.query("SELECT * FROM payments WHERE id=$1", [row.payment_id])
      ).rows[0];
      const verified = await remote(
        `/payments/${row.provider_payment_id}`,
        settings,
      );
      if (
        verified.id !== row.provider_payment_id ||
        verified.order_id !== payment.provider_order_id ||
        verified.currency !== "INR" ||
        verified.amount !== paise(payment.amount) ||
        !["captured", ...(replay ? ["refunded"] : [])].includes(verified.status)
      )
        throw fail(
          409,
          "Razorpay has not confirmed a matching captured payment for this bill.",
        );
      if (
        !replay &&
        Number(verified.amount_refunded || 0) !==
          paise(payment.refunded_amount || 0)
      )
        throw fail(
          409,
          "Razorpay shows a refund outside EatHub. Reconcile this payment before issuing another refund.",
        );
      attempted = true;
      const refund = await remote(
        `/payments/${row.provider_payment_id}/refund`,
        settings,
        row.provider_request,
        { "X-Refund-Idempotency": row.id },
      );
      return await applyRemote(row, refund);
    } catch (e) {
      // A timeout/HTTP error after submission does not prove that money stayed put.
      // Keep its amount reserved and retry the SAME persisted provider request/key.
      if (attempted || e.status !== 409) {
        return mark(
          row,
          "unknown",
          "Confirmation is delayed. Use Check status to safely retry this same refund.",
        );
      }
      await mark(row, "failed", e.message);
      throw e;
    }
  }
  app.get(
    "/api/refunds/:orderId",
    security.authorize("/api/refunds/:orderId", "get"),
    async (req, res) => {
      res.json(await summary(req.params.orderId, req.user.role === "admin"));
    },
  );
  app.post(
    "/api/refunds/:orderId",
    security.authorize("/api/refunds/:orderId", "post"),
    async (req, res) => {
      const input = inputFor(req.body);
      const key = req.get("Idempotency-Key");
      if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{10,100}$/.test(key))
        throw fail(
          400,
          "Send a unique Idempotency-Key of 10–100 letters, numbers, underscores or hyphens.",
        );
      const hash = createHash("sha256")
        .update(JSON.stringify({ orderId: req.params.orderId, ...input }))
        .digest("hex");
      const prepared = await transaction(pool, async (client) => {
        const tenant = req.user.restaurantId;
        await lock(client, tenant);
        const prior = (
          await client.query(
            "SELECT * FROM order_refunds WHERE restaurant_id=$1 AND idempotency_key=$2",
            [tenant, key],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash)
            throw fail(
              409,
              "This request key was already used for a different refund.",
            );
          return { row: prior, replay: true };
        }
        const order = (
          await client.query(
            "SELECT * FROM orders WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",
            [req.params.orderId, tenant],
          )
        ).rows[0];
        if (
          !order ||
          order.status !== "Completed" ||
          !captured(order.payment_status)
        )
          throw fail(409, "Only completed, paid orders can be refunded.");
        const payment = await paymentFor(client, order.id);
        if (
          !payment?.provider_order_id ||
          !/^pay_[a-zA-Z0-9]+$/.test(payment.transaction_id || "")
        )
          throw fail(
            409,
            "This payment has no verified Razorpay payment ID. Counter payments need a counter refund.",
          );
        if (!config(tenant))
          throw fail(
            409,
            "Razorpay test refunds are not configured for this restaurant.",
          );
        const refunds = await records(client, order.id);
        if (refunds.some(unresolved))
          throw fail(
            409,
            "A refund is awaiting confirmation. Check its status first.",
          );
        const selected = refundSelection(
          refundableLines(order, payment, refunds),
          input,
        );
        const used = refunds
          .filter((r) => r.status === "processed")
          .reduce((n, r) => n + r.amount_paise, 0);
        if (used + selected.amount > paise(payment.amount))
          throw fail(409, "The refund exceeds the remaining paid amount.");
        const remainder = paise(payment.amount) - used - selected.amount;
        if (remainder > 0 && remainder < 100)
          throw fail(
            400,
            "This selection would leave less than ₹1. Refund the full remaining balance instead.",
          );
        const id = randomUUID();
        const providerRequest = {
          amount: selected.amount,
          speed: "normal",
          receipt: id,
          notes: { eathub_refund_id: id, order_id: order.id },
        };
        const row = (
          await client.query(
            "INSERT INTO order_refunds(id,restaurant_id,order_id,payment_id,provider_payment_id,idempotency_key,request_hash,kind,items,amount_paise,reason,requested_by,provider_request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
            [
              id,
              tenant,
              order.id,
              payment.id,
              payment.transaction_id,
              key,
              hash,
              input.kind,
              JSON.stringify(selected.items),
              selected.amount,
              input.reason,
              req.user.userId,
              JSON.stringify(providerRequest),
            ],
          )
        ).rows[0];
        await updateTotals(client, row);
        return { row, replay: false };
      });
      const row = await submit(prepared.row, prepared.replay);
      res
        .status(unresolved(row) ? 202 : 200)
        .json({
          ...(await summary(row.order_id, true)),
          refund: publicRefund(row, true),
        });
    },
  );
  app.post(
    "/api/refunds/:orderId/:refundId/sync",
    security.authorize("/api/refunds/:orderId/:refundId/sync", "post"),
    async (req, res) => {
      const row = (
        await pool.query(
          "SELECT * FROM order_refunds WHERE id=$1 AND order_id=$2 AND restaurant_id=$3",
          [req.params.refundId, req.params.orderId, req.user.restaurantId],
        )
      ).rows[0];
      if (!row) throw fail(404, "Refund not found");
      const updated = await submit(row, true);
      res
        .status(unresolved(updated) ? 202 : 200)
        .json({
          ...(await summary(row.order_id, true)),
          refund: publicRefund(updated, true),
        });
    },
  );
  async function handleWebhook(entity) {
    if (!entity || typeof entity.id !== "string")
      throw fail(400, "Invalid refund event");
    const row = (
      await pool.query(
        "SELECT * FROM order_refunds WHERE provider_refund_id=$1 OR id=$2",
        [entity.id, entity.notes?.eathub_refund_id || entity.receipt || null],
      )
    ).rows[0];
    // Unrelated/dashboard-created refunds belong to the separate reconciliation workflow.
    if (row && config(row.restaurant_id)) await applyRemote(row, entity);
  }
  return { handleWebhook };
}
module.exports = { registerRefunds, inputFor };
