const { createHmac, timingSafeEqual, randomUUID } = require("crypto");
const { transaction, totals } = require("./commerce");
const { fail } = require("./security");
function signature(value, signature, secret) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature))
    return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(value).digest(),
    Buffer.from(signature, "hex"),
  );
}
function config(restaurant) {
  const key = process.env.RAZORPAY_KEY_ID,
    secret = process.env.RAZORPAY_KEY_SECRET;
  return key?.startsWith("rzp_test_") &&
    secret &&
    process.env.RAZORPAY_RESTAURANT_ID === restaurant
    ? { key, secret }
    : null;
}
async function provider(path, settings, body) {
  let response;
  try {
    response = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${settings.key}:${settings.secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw fail(
      503,
      "Payment service is temporarily unavailable. Please retry.",
    );
  }
  if (!response.ok)
    throw fail(
      502,
      "Payment provider could not complete this request. Please contact the restaurant.",
    );
  return response.json();
}
function registerGateway(app, pool, security, settle, remote = provider) {
  const route = (method, path, fn) =>
    app[method](path, security.authorize(path, method), async (req, res) =>
      res.json(await fn(req)),
    );
  route("get", "/checkout/config/:restaurant_id", async (req) => ({
    enabled: !!config(req.params.restaurant_id),
    mode: "test",
  }));
  route("post", "/checkout/:order_id", async (req) => {
    const settings = config(req.user.restaurantId);
    if (!settings)
      throw fail(
        409,
        "Online test checkout is not configured for this restaurant.",
      );
    return transaction(pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        req.user.restaurantId,
      ]);
      const o = (
        await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [
          req.params.order_id,
        ])
      ).rows[0];
      if (
        ["Completed", "Cancelled"].includes(o.status) ||
        ["Paid", "SUCCESS"].includes(o.payment_status)
      )
        throw fail(409, "Order is already settled");
      let p = (
        await c.query(
          "SELECT * FROM payments WHERE order_id=$1 AND payment_status IN ('Pending','INITIATED','PENDING_CONFIRMATION','Paid','SUCCESS') ORDER BY created_at DESC LIMIT 1",
          [o.id],
        )
      ).rows[0];
      if (p && !p.provider_order_id)
        throw fail(409, "Resolve the existing counter payment first.");
      const amount = Math.round(totals(o).total * 100);
      if (amount < 100)
        throw fail(400, "Online checkout requires a bill of at least ₹1.");
      if (!p) {
        const remoteOrder = await remote("/orders", settings, {
          amount,
          currency: "INR",
          receipt: o.id.slice(0, 40),
          notes: { restaurant_id: o.restaurant_id, order_id: o.id },
        });
        p = (
          await c.query(
            "INSERT INTO payments(id,restaurant_id,order_id,order_number,table_id,table_name,amount,payment_method,payment_status,provider_order_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,'Online','Pending',$8,'Razorpay TEST payment: no real money collected') RETURNING *",
            [
              randomUUID(),
              o.restaurant_id,
              o.id,
              o.order_number,
              o.table_id,
              o.table_name,
              amount / 100,
              remoteOrder.id,
            ],
          )
        ).rows[0];
      }
      return {
        key: settings.key,
        provider_order_id: p.provider_order_id,
        amount,
        currency: "INR",
        mode: "test",
        payment_id: p.id,
      };
    });
  });
  async function finish(payment) {
    return transaction(pool, async (c) => {
      const p0 = (
        await c.query("SELECT * FROM payments WHERE provider_order_id=$1", [
          payment.order_id,
        ])
      ).rows[0];
      if (!p0) throw fail(404, "Payment record not found");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        p0.restaurant_id,
      ]);
      const p = (
          await c.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [
            p0.id,
          ])
        ).rows[0],
        o = (
          await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [
            p.order_id,
          ])
        ).rows[0];
      if (
        payment.status !== "captured" ||
        payment.currency !== "INR" ||
        Number(payment.amount) !== Math.round(Number(p.amount) * 100) ||
        payment.order_id !== p.provider_order_id
      )
        throw fail(
          409,
          "Payment has not been captured for this bill. Please check again shortly.",
        );
      await c.query("UPDATE payments SET transaction_id=$1 WHERE id=$2", [
        payment.id,
        p.id,
      ]);
      return {
        payment: await settle(
          c,
          o,
          { ...p, transaction_id: payment.id },
          "Paid",
        ),
        mode: "test",
      };
    });
  }
  route("post", "/checkout/:order_id/verify", async (req) => {
    const settings = config(req.user.restaurantId);
    if (!settings) throw fail(409, "Online test checkout is not configured.");
    const p = (
      await pool.query(
        "SELECT * FROM payments WHERE order_id=$1 AND provider_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [req.params.order_id],
      )
    ).rows[0];
    if (!p) throw fail(404, "Payment record not found");
    const b = req.body;
    if (
      !/^pay_[a-zA-Z0-9]+$/.test(b.razorpay_payment_id || "") ||
      !signature(
        `${p.provider_order_id}|${b.razorpay_payment_id}`,
        b.razorpay_signature,
        settings.secret,
      )
    )
      throw fail(400, "Payment verification failed");
    const payment = await remote(
      `/payments/${b.razorpay_payment_id}`,
      settings,
    );
    return finish(payment);
  });
  app.post("/webhooks/razorpay", async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (
      !secret ||
      !req.rawBody ||
      !signature(req.rawBody, req.headers["x-razorpay-signature"], secret)
    )
      throw fail(400, "Invalid webhook signature");
    if (req.body.event === "payment.captured") {
      const payment = req.body.payload?.payment?.entity;
      const p = (
        await pool.query(
          "SELECT restaurant_id FROM payments WHERE provider_order_id=$1",
          [payment?.order_id],
        )
      ).rows[0];
      if (p && config(p.restaurant_id)) await finish(payment);
    }
    res.json({ received: true });
  });
}
module.exports = { registerGateway, signature, config };
