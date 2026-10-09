const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID, createHmac } = require("node:crypto");
const express = require("express");
require("express-async-errors");
const jwt = require("jsonwebtoken");
const { PGlite } = require("@electric-sql/pglite");
const { embeddedPool } = require("../lib/embedded-pool");
const { createSecurity } = require("../lib/security");
const { registerCommerce } = require("../lib/commerce");
const { registerGateway } = require("../lib/gateway");
const { registerRefunds } = require("../lib/refunds");
const { applyPendingMigrations } = require("../lib/migrations");
const { checkDatabase } = require("../lib/readiness");
const { refundableLines, refundSelection } = require("../lib/refund-amounts");
let db,
  pool,
  server,
  root,
  tokens,
  sequence = 0;
const payments = new Map(),
  requests = new Map();
const webhookSecret = "refund-test-webhook-secret";
async function remote(path, settings, body, headers) {
  assert.equal(settings.key, "rzp_test_refunds");
  const [, , paymentId, , refundId] = path.split("/");
  const payment = payments.get(paymentId);
  assert.ok(payment, path);
  if (!body && !refundId) return { ...payment, ...payment.mismatch };
  if (refundId)
    return [...requests.values()].find((r) => r.refund.id === refundId).refund;
  assert.match(headers["X-Refund-Idempotency"], /^[\w-]{10,}$/);
  const key = headers["X-Refund-Idempotency"];
  let saved = requests.get(key);
  if (saved) {
    assert.deepEqual(
      saved.body,
      body,
      "provider retries must preserve the exact body",
    );
    saved.calls++;
    return saved.refund;
  }
  const refund = {
    id: `rfnd_${++sequence}`,
    payment_id: paymentId,
    currency: "INR",
    amount: body.amount,
    status: payment.outcome || "processed",
    notes: body.notes,
    receipt: body.receipt,
  };
  saved = { body, refund, calls: 1 };
  requests.set(key, saved);
  if (refund.status === "processed") payment.amount_refunded += body.amount;
  if (payment.timeout)
    throw new Error("Connection lost AFTER the provider created the refund");
  return refund;
}
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(__dirname + "/schema.sql", "utf8"));
  await applyPendingMigrations(db);
  await db.exec(`INSERT INTO restaurant_admin(id,name,email,password,restaurentname,phonenumber,branchname,country,branchaddress) VALUES
    ('r1','Owner','one@test.invalid','unused','One','1','Main','India','Street'),
    ('r2','Owner','two@test.invalid','unused','Two','2','Main','India','Street');
    INSERT INTO restaurant_area VALUES ('a1','Dining','r1');
    INSERT INTO restaurant_tables(id,name,seat_capacity,is_active,restaurant_id,area_id) VALUES ('t1','T1',4,'true','r1','a1');
    INSERT INTO restaurant_staff(id,name,email,phone_number,role,restaurant_id,password,status) VALUES
    ('w1','Waiter','w@test.invalid','1','waiter','r1','unused','active'),('k1','Chef','k@test.invalid','1','chef','r1','unused','active');
    INSERT INTO customer_details VALUES ('c1','Customer','unused','1','c@test.invalid');
    INSERT INTO super_admin(id,email,password) VALUES ('s1','s@test.invalid','unused');`);
  pool = embeddedPool(db);
  const security = createSecurity(
    pool,
    jwt,
    "test-refund-jwt-secret-at-least-thirty-two-bytes",
  );
  const claims = {
    admin: { role: "admin", userId: "r1", restaurantId: "r1" },
    other: { role: "admin", userId: "r2", restaurantId: "r2" },
    waiter: { role: "waiter", userId: "w1", restaurantId: "r1" },
    kitchen: { role: "kot", userId: "k1", restaurantId: "r1" },
    guest: { role: "guest", userId: "g1", restaurantId: "r1", tableId: "t1" },
    stranger: {
      role: "guest",
      userId: "g2",
      restaurantId: "r1",
      tableId: "t1",
    },
    customer: { role: "customer", userId: "c1" },
    platform: { role: "super_admin", userId: "s1" },
  };
  tokens = Object.fromEntries(
    Object.entries(claims).map(([k, v]) => [k, security.sign(v)]),
  );
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  const commerce = registerCommerce(app, pool, security);
  const refunds = registerRefunds(app, pool, security, remote);
  registerGateway(
    app,
    pool,
    security,
    commerce.settle,
    remote,
    refunds.handleWebhook,
  );
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  root = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    RAZORPAY_KEY_ID: "rzp_test_refunds",
    RAZORPAY_KEY_SECRET: "test-secret",
    RAZORPAY_RESTAURANT_ID: "r1",
    RAZORPAY_WEBHOOK_SECRET: webhookSecret,
  });
});
after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});
async function seed(options = {}) {
  const id = `o${++sequence}`,
    paymentId = `pay_${id}`;
  const items = [
    { id: "meal", name: "Meal", price: 100, quantity: 2 },
    { id: "drink", name: "Drink", price: 50, quantity: 1 },
  ];
  await pool.query(
    "INSERT INTO orders(id,restaurant_id,customer_id,waiter_id,table_id,order_number,items,total_price,discount_amount,tax_amount,tax_mode,status,order_status,payment_status) VALUES($1::text,'r1',$2,'w1','t1',$1::text,$3,250,25,11.25,'exclusive',$4,'Completed',$5)",
    [
      id,
      options.customer || "g1",
      JSON.stringify(items),
      options.status || "Completed",
      options.paymentStatus || "Paid",
    ],
  );
  await pool.query(
    "INSERT INTO payments(id,restaurant_id,order_id,amount,payment_method,payment_status,provider_order_id,transaction_id) VALUES($1,'r1',$2,236.25,$3,$4,$5,$6)",
    [
      `p${id}`,
      id,
      options.cash ? "Cash" : "Online",
      options.paymentStatus || "Paid",
      options.cash ? null : `order_${id}`,
      options.cash ? null : paymentId,
    ],
  );
  payments.set(paymentId, {
    id: paymentId,
    order_id: `order_${id}`,
    amount: 23625,
    amount_refunded: 0,
    currency: "INR",
    status: "captured",
    ...options.provider,
  });
  return id;
}
async function api(
  method,
  path,
  role = "admin",
  body,
  key = randomUUID(),
  headers = {},
) {
  const response = await fetch(root + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
      "Idempotency-Key": key,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const full = { kind: "full", reason: "Returned the complete order" };
const partial = {
  kind: "items",
  reason: "One meal returned",
  items: [{ line_index: 0, quantity: 1 }],
};
const post = (id, body = full, key, role = "admin") =>
  api("POST", `/api/refunds/${id}`, role, body, key);
const order = async (id) =>
  (await pool.query("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
async function webhook(refund, event = "refund.processed", valid = true) {
  const body = { event, payload: { refund: { entity: refund } } };
  return api("POST", "/webhooks/razorpay", null, body, randomUUID(), {
    "x-razorpay-signature": valid
      ? createHmac("sha256", webhookSecret)
          .update(JSON.stringify(body))
          .digest("hex")
      : "0".repeat(64),
  });
}
test("refund authorization is admin-only; reads remain scoped to tenant, guest and historical customer", async () => {
  const id = await seed();
  assert.equal((await post(id, full, undefined, null)).status, 401);
  for (const role of ["waiter", "kitchen", "guest", "customer", "platform"])
    assert.equal((await post(id, full, undefined, role)).status, 403, role);
  for (const role of ["other", "stranger"])
    assert.equal(
      (await api("GET", `/api/refunds/${id}`, role)).status,
      404,
      role,
    );
  assert.equal((await post(id, full, undefined, "other")).status, 404);
  assert.equal((await api("GET", `/api/refunds/${id}`, "guest")).status, 200);
  const historical = await seed({ customer: "c1" });
  assert.equal(
    (await api("GET", `/api/refunds/${historical}`, "customer")).status,
    200,
  );
  assert.equal(
    (await api("GET", `/api/refunds/${id}`, "customer")).status,
    404,
  );
});
test("only completed, captured online payments qualify; missing configuration and input tampering fail", async () => {
  for (const options of [
    { cash: true },
    { status: "Preparing" },
    { paymentStatus: "Pending" },
  ])
    assert.equal((await post(await seed(options))).status, 409);
  const id = await seed();
  process.env.RAZORPAY_KEY_ID = "rzp_live_disabled";
  assert.equal((await post(id)).status, 409);
  process.env.RAZORPAY_KEY_ID = "rzp_test_refunds";
  assert.equal((await post(id, full, "short")).status, 400);
  for (const body of [
    { ...full, amount: 1 },
    { ...full, reason: "x" },
    { ...partial, items: [partial.items[0], partial.items[0]] },
    { ...partial, items: [{ line_index: 0, quantity: -1 }] },
  ])
    assert.equal((await post(id, body)).status, 400);
  assert.equal(
    (await post(id, { ...partial, items: [{ line_index: 0, quantity: 3 }] }))
      .status,
    409,
  );
});
test("partial refunds use the original discounted and taxed item prices; remaining full refund closes the order", async () => {
  const id = await seed();
  const first = await post(id, partial);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.refund.amount_paise, 9450);
  assert.equal(first.body.refund_status, "Partially Refunded");
  assert.equal(first.body.lines[0].remaining_quantity, 1);
  assert.equal((await order(id)).status, "Completed");
  const rest = await post(id);
  assert.equal(rest.body.refund.amount_paise, 14175);
  assert.equal(rest.body.refunded_amount_paise, 23625);
  const saved = await order(id);
  assert.equal(saved.status, "Refunded");
  assert.equal(saved.order_status, "Refunded");
  assert.equal(saved.payment_status, "Paid");
  assert.equal(Number(saved.refunded_amount), 236.25);
  assert.equal(Number(saved.total_price), 250, "original bill stays unchanged");
  const guest = (await api("GET", `/api/refunds/${id}`, "guest")).body;
  assert.equal(guest.refunds.length, 2);
  for (const field of [
    "reason",
    "requested_by",
    "last_error",
    "provider_refund_id",
  ])
    assert.equal(guest.refunds[0][field], undefined);
  assert.equal(guest.can_refund, undefined);
  assert.equal((await post(id)).status, 409);
});
test("same request key replays one refund; changing its contents is rejected", async () => {
  const id = await seed(),
    key = randomUUID(),
    beforeCount = requests.size;
  const a = await post(id, full, key),
    b = await post(id, full, key);
  assert.equal(a.body.refund.id, b.body.refund.id);
  assert.equal(requests.size, beforeCount + 1);
  assert.equal((await post(id, partial, key)).status, 409);
});
test("pending refunds reserve items and amount; signed matching webhooks finalize without regression", async () => {
  const id = await seed({ provider: { outcome: "pending" } });
  const submitted = await post(id, partial);
  assert.equal(submitted.status, 202);
  assert.equal(submitted.body.pending_amount_paise, 9450);
  assert.equal((await post(id)).status, 409);
  assert.equal((await order(id)).status, "Completed");
  const saved = requests.get(submitted.body.refund.id).refund;
  assert.equal(
    (
      await webhook(
        { ...saved, status: "processed" },
        "refund.processed",
        false,
      )
    ).status,
    400,
  );
  assert.equal(
    (await webhook({ ...saved, status: "processed", amount: 1 })).status,
    502,
  );
  assert.equal(
    (await webhook({ ...saved, status: "processed", payment_id: "pay_wrong" }))
      .status,
    502,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await webhook({ ...saved, status: "processed" })).status,
      200,
    );
  await webhook(saved, "refund.created");
  await webhook({ ...saved, status: "failed" }, "refund.failed");
  assert.equal(Number((await order(id)).refunded_amount), 94.5);
  assert.equal(
    (await api("GET", `/api/refunds/${id}`)).body.refunds[0].status,
    "processed",
  );
});
test("lost provider response retries the persisted idempotency key and exact request, never a second refund", async () => {
  const id = await seed({ provider: { timeout: true } }),
    count = requests.size;
  const first = await post(id);
  assert.equal(first.status, 202);
  assert.equal(first.body.refund.status, "unknown");
  assert.equal((await post(id)).status, 409);
  const synced = await api(
    "POST",
    `/api/refunds/${id}/${first.body.refund.id}/sync`,
    "admin",
    {},
  );
  assert.equal(synced.status, 200);
  assert.equal(synced.body.refund.status, "processed");
  assert.equal(requests.size, count + 1);
  assert.equal(requests.get(first.body.refund.id).calls, 2);
});
test("a webhook can recover an unknown refund using persisted notes before a provider ID was saved", async () => {
  const id = await seed({ provider: { timeout: true } });
  const first = await post(id);
  assert.equal(
    (await webhook(requests.get(first.body.refund.id).refund)).status,
    200,
  );
  assert.equal((await order(id)).status, "Refunded");
});
test("failed provider refunds release their quantities; an old pending webhook does not block a retry", async () => {
  const id = await seed({ provider: { outcome: "failed" } });
  const first = await post(id, partial);
  assert.equal(first.body.refund.status, "failed");
  assert.equal(first.body.lines[0].remaining_quantity, 2);
  const saved = requests.get(first.body.refund.id).refund;
  await webhook({ ...saved, status: "pending" }, "refund.created");
  payments.get(`pay_${id}`).outcome = "processed";
  const next = await post(id);
  assert.equal(next.body.refund.amount_paise, 23625);
  assert.equal(next.body.refund_status, "Refunded");
});
test("provider mismatches and outside refunds are blocked before sending money", async () => {
  for (const mismatch of [
    { amount: 1 },
    { currency: "USD" },
    { order_id: "order_other" },
    { status: "authorized" },
    { amount_refunded: 100 },
  ]) {
    const id = await seed({ provider: { mismatch } }),
      count = requests.size;
    assert.equal((await post(id)).status, 409);
    assert.equal(requests.size, count);
    assert.equal(Number((await order(id)).refunded_amount), 0);
  }
});
test("concurrent distinct keys cannot reserve two refunds for the same order", async () => {
  const id = await seed({ provider: { outcome: "pending" } }),
    count = requests.size;
  const responses = await Promise.all([post(id, partial), post(id, partial)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
  assert.equal(requests.size, count + 1);
});
test("late capture events and existing payment APIs cannot undo a full refund or charge again", async () => {
  const id = await seed();
  await post(id);
  const body = {
    event: "payment.captured",
    payload: { payment: { entity: payments.get(`pay_${id}`) } },
  };
  const headers = {
    "x-razorpay-signature": createHmac("sha256", webhookSecret)
      .update(JSON.stringify(body))
      .digest("hex"),
  };
  assert.equal(
    (await api("POST", "/webhooks/razorpay", null, body, randomUUID(), headers))
      .status,
    200,
  );
  assert.equal((await order(id)).status, "Refunded");
  assert.equal((await api("POST", `/checkout/${id}`, "guest", {})).status, 409);
  const p = await api("POST", "/createPayment", "admin", {
    order_id: id,
    payment_method: "Cash",
  });
  assert.equal(p.body.payment.id, `p${id}`);
  assert.equal(
    (await api("PUT", `/updateOrderStatus/${id}`, "admin", { status: "Ready" }))
      .status,
    409,
  );
});
test("integer allocation covers exclusive/inclusive tax, repeated menu IDs, and final paise exactly", () => {
  for (const tax_mode of ["inclusive", "exclusive"]) {
    const order = {
      items: [
        { id: "same", name: "Small", price: 10, quantity: 2 },
        { id: "same", name: "Large", price: 30, quantity: 1 },
      ],
      total_price: 50,
      discount_amount: 10.01,
      tax_amount: 2,
      tax_mode,
    };
    const payment = { amount: tax_mode === "inclusive" ? 39.99 : 41.99 };
    const lines = refundableLines(order, payment, []);
    const first = refundSelection(lines, {
      kind: "items",
      items: [{ line_index: 0, quantity: 1 }],
    });
    const remaining = refundableLines(order, payment, [
      { status: "processed", items: first.items },
    ]);
    const rest = refundSelection(remaining, { kind: "full" });
    assert.equal(first.amount + rest.amount, Math.round(payment.amount * 100));
    assert.equal(remaining[1].remaining_quantity, 1);
  }
  assert.throws(
    () =>
      refundSelection(
        [
          {
            remaining_quantity: 1,
            unit_amounts_paise: [99],
            name: "Tiny",
            line_index: 0,
          },
        ],
        { kind: "full" },
      ),
    /at least ₹1/,
  );
});
test("pending migrations are repeatable and preserve paid/refunded history", async () => {
  const id = await seed();
  await post(id);
  const before = await order(id);
  await applyPendingMigrations(db);
  await applyPendingMigrations(db);
  await checkDatabase(pool);
  assert.deepEqual(await order(id), before);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT version FROM eathub_schema_versions ORDER BY version",
      )
    ).rows.map((r) => r.version),
    [2, 3],
  );
});
