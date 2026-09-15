const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHmac } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { embeddedPool } = require("../lib/embedded-pool");
const express = require("express");
require("express-async-errors");
const jwt = require("jsonwebtoken");
const { createSecurity } = require("../lib/security");
const { registerCommerce } = require("../lib/commerce");
const { registerGateway } = require("../lib/gateway");
let pool,
  server,
  root,
  admin,
  guest,
  otherGuest,
  kitchen,
  remoteCreates = 0,
  checkout;
let providerPayment = {
  id: "pay_test1",
  order_id: "order_test1",
  status: "captured",
  currency: "INR",
  amount: 20000,
};
const keySecret = "test-provider-secret",
  webhookSecret = "test-webhook-secret";
before(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(__dirname + "/schema.sql", "utf8"));
  await db.exec(
    fs.readFileSync(
      __dirname + "/../migrations/002_schema_compatibility.sql",
      "utf8",
    ),
  );
  await db.exec(
    "INSERT INTO restaurant_admin(id,name,email,password,restaurentname,phonenumber,branchname,country,branchaddress) VALUES('r1','Owner','owner@test.invalid','unused','Test','1','Main','India','Test Street'); INSERT INTO restaurant_area VALUES('a1','Dining','r1'); INSERT INTO restaurant_tables(id,name,seat_capacity,is_active,restaurant_id,area_id) VALUES('t1','T1',4,'true','r1','a1'); INSERT INTO restaurant_staff(id,name,email,phone_number,role,restaurant_id,password,status) VALUES('k1','Chef','chef@test.invalid','1','Chef','r1','unused','active'); INSERT INTO orders(id,restaurant_id,customer_id,table_id,order_number,items,total_price,status,order_status) VALUES('o1','r1','g1','t1','0913-1','[]',200,'Pending','KOT');",
  );
  pool = embeddedPool(db);
  const security = createSecurity(
    pool,
    jwt,
    "test-jwt-secret-with-at-least-thirty-two-bytes",
  );
  admin = security.sign({ role: "admin", userId: "r1", restaurantId: "r1" });
  guest = security.sign({
    role: "guest",
    userId: "g1",
    tableId: "t1",
    restaurantId: "r1",
  });
  otherGuest = security.sign({
    role: "guest",
    userId: "g2",
    tableId: "t1",
    restaurantId: "r1",
  });
  kitchen = security.sign({ role: "kot", userId: "k1", restaurantId: "r1" });
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  const commerce = registerCommerce(app, pool, security);
  registerGateway(
    app,
    pool,
    security,
    commerce.settle,
    async (path, settings, body) => {
      if (path === "/orders") {
        remoteCreates++;
        assert.equal(body.amount, 20000);
        return { id: "order_test1" };
      }
      assert.equal(path, "/payments/pay_test1");
      return providerPayment;
    },
  );
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  root = `http://127.0.0.1:${server.address().port}`;
  process.env.RAZORPAY_KEY_ID = "rzp_test_example";
  process.env.RAZORPAY_KEY_SECRET = keySecret;
  process.env.RAZORPAY_RESTAURANT_ID = "r1";
  process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});
async function api(method, path, token, body, headers = {}) {
  const response = await fetch(root + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const callback = () => ({
  razorpay_payment_id: "pay_test1",
  razorpay_order_id: "attacker-supplied-order",
  razorpay_signature: createHmac("sha256", keySecret)
    .update("order_test1|pay_test1")
    .digest("hex"),
});
test("test checkout enforces restaurant configuration, ownership, and one pending provider order", async () => {
  process.env.RAZORPAY_KEY_ID = "rzp_live_disabled";
  assert.equal(
    (await api("GET", "/checkout/config/r1", guest)).body.enabled,
    false,
  );
  assert.equal((await api("POST", "/checkout/o1", guest, {})).status, 409);
  process.env.RAZORPAY_KEY_ID = "rzp_test_example";
  assert.equal((await api("POST", "/checkout/o1", otherGuest, {})).status, 404);
  assert.equal((await api("POST", "/checkout/o1", kitchen, {})).status, 403);
  checkout = await api("POST", "/checkout/o1", guest, { amount: 1 });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  assert.equal(checkout.body.amount, 20000);
  assert.equal(
    (await api("POST", "/checkout/o1", guest, {})).body.payment_id,
    checkout.body.payment_id,
  );
  assert.equal(remoteCreates, 1);
  assert.equal(
    (
      await api(
        "PUT",
        `/updatePaymentStatus/${checkout.body.payment_id}`,
        admin,
        { payment_status: "Paid" },
      )
    ).status,
    409,
  );
  assert.equal((await api("DELETE", "/deleteOrder/o1", admin)).status, 409);
});
test("forged signatures, uncaptured payments, and wrong amounts cannot settle a bill", async () => {
  assert.equal(
    (
      await api("POST", "/checkout/o1/verify", guest, {
        ...callback(),
        razorpay_signature: "0".repeat(64),
      })
    ).status,
    400,
  );
  providerPayment = { ...providerPayment, status: "authorized" };
  assert.equal(
    (await api("POST", "/checkout/o1/verify", guest, callback())).status,
    409,
  );
  providerPayment = { ...providerPayment, status: "captured", amount: 1 };
  assert.equal(
    (await api("POST", "/checkout/o1/verify", guest, callback())).status,
    409,
  );
  providerPayment = { ...providerPayment, amount: 20000 };
  assert.equal(
    (await pool.query("SELECT payment_status FROM orders WHERE id='o1'"))
      .rows[0].payment_status,
    "Pending",
  );
});
test("verified payment retries preserve the kitchen ticket until food is served", async () => {
  assert.equal(
    (await api("POST", "/checkout/o1/verify", guest, callback())).status,
    200,
  );
  assert.equal(
    (await api("POST", "/checkout/o1/verify", guest, callback())).status,
    200,
  );
  let order = (await pool.query("SELECT * FROM orders WHERE id='o1'")).rows[0];
  assert.equal(order.payment_status, "Paid");
  assert.equal(order.status, "Pending");
  assert.equal(order.order_status, "KOT");
  assert.equal(
    (
      await pool.query(
        "SELECT current_status FROM restaurant_tables WHERE id='t1'",
      )
    ).rows[0].current_status,
    "occupied",
  );
  assert.equal(
    (
      await api("PUT", "/updateOrderStatus/o1", kitchen, {
        status: "Preparing",
      })
    ).status,
    200,
  );
  assert.equal(
    (await api("PUT", "/updateOrderStatus/o1", kitchen, { status: "Ready" }))
      .status,
    200,
  );
  assert.equal(
    (await api("PUT", "/updateOrderStatus/o1", admin, { status: "Completed" }))
      .status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT current_status FROM restaurant_tables WHERE id='t1'",
      )
    ).rows[0].current_status,
    "available",
  );
});
test("webhook signature is required and duplicate captured events are safe", async () => {
  const body = {
    event: "payment.captured",
    payload: { payment: { entity: providerPayment } },
  };
  assert.equal(
    (await api("POST", "/webhooks/razorpay", null, body)).status,
    400,
  );
  const signature = createHmac("sha256", webhookSecret)
    .update(JSON.stringify(body))
    .digest("hex");
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await api("POST", "/webhooks/razorpay", null, body, {
          "x-razorpay-signature": signature,
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*) AS count FROM payments WHERE order_id='o1' AND payment_status='Paid'",
      )
    ).rows[0].count,
    1,
  );
});
