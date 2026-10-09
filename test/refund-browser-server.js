// Disposable browser-test fixture. Uses the real app/auth/routes and embedded
// PostgreSQL; only Razorpay HTTP is simulated. Never connects to Neon or Razorpay.
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const { embeddedPool } = require("../lib/embedded-pool");
const { applyPendingMigrations } = require("../lib/migrations");
async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Test fixture cannot run in production");
  Object.assign(process.env, {
    DATABASE_URL: "postgres://test-unused",
    JWT_SECRET: "browser-refund-test-secret-at-least-thirty-two-bytes",
    RAZORPAY_KEY_ID: "rzp_test_fixture",
    RAZORPAY_KEY_SECRET: "fixture-only",
    RAZORPAY_RESTAURANT_ID: "refund-demo",
    RAZORPAY_WEBHOOK_SECRET: "fixture-webhook",
  });
  const db = new PGlite();
  await db.exec(fs.readFileSync(__dirname + "/schema.sql", "utf8"));
  await applyPendingMigrations(db);
  const password = await require("bcrypt").hash("EatHubDemo123!", 4);
  await db.query(
    "INSERT INTO restaurant_admin(id,name,email,password,restaurentname,phonenumber,branchname,country,branchaddress) VALUES('refund-demo','Demo owner','admin@demo.invalid',$1,'Olive & Ember','0000000000','Garden','India','Demo address')",
    [password],
  );
  await db.exec(`INSERT INTO restaurant_area VALUES ('dining','Dining','refund-demo');
    INSERT INTO restaurant_tables(id,name,seat_capacity,is_active,restaurant_id,area_id) VALUES ('refund-table','Table 4',4,'true','refund-demo','dining');
    INSERT INTO restaurant_menu_category VALUES ('food','Food','refund-demo');
    INSERT INTO restaurant_menu_items(id,item_name,item_category,item_dec,preparation_time,availability,price,menu_category_id,restaurant_id,category_name) VALUES
    ('meal','Garden meal','Veg','Seasonal vegetables','10','Yes',100,'food','refund-demo','Food'),('drink','Fresh juice','Veg','Orange juice','5','Yes',50,'food','refund-demo','Food');
    INSERT INTO orders(id,restaurant_id,customer_id,table_id,table_name,order_number,items,total_price,discount_amount,tax_amount,tax_mode,status,order_status,payment_status)
    VALUES ('refund-order','refund-demo','refund-guest','refund-table','Table 4','1008-1','[{"id":"meal","name":"Garden meal","price":100,"quantity":2},{"id":"drink","name":"Fresh juice","price":50,"quantity":1}]',250,25,11.25,'exclusive','Completed','Completed','Paid');
    INSERT INTO payments(id,restaurant_id,order_id,order_number,amount,payment_method,payment_status,provider_order_id,transaction_id)
    VALUES ('refund-payment','refund-demo','refund-order','1008-1',236.25,'Online','Paid','order_fixture','pay_fixture');`);
  const providerPayment = {
    id: "pay_fixture",
    order_id: "order_fixture",
    amount: 23625,
    currency: "INR",
    status: "captured",
    amount_refunded: 0,
  };
  const refunds = new Map();
  global.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (new URL(url).origin !== "https://api.razorpay.com")
      throw new Error("Unexpected network access in test fixture");
    let result;
    if (path === "/v1/payments/pay_fixture") result = providerPayment;
    else if (
      path === "/v1/payments/pay_fixture/refund" &&
      options.method === "POST"
    ) {
      const key = options.headers["X-Refund-Idempotency"];
      result = refunds.get(key);
      if (!result) {
        const body = JSON.parse(options.body);
        result = {
          id: `rfnd_fixture${refunds.size + 1}`,
          payment_id: "pay_fixture",
          amount: body.amount,
          currency: "INR",
          status: refunds.size ? "processed" : "pending",
          notes: body.notes,
          receipt: body.receipt,
        };
        refunds.set(key, result);
        if (result.status === "processed")
          providerPayment.amount_refunded += result.amount;
      }
    } else {
      result = [...refunds.values()].find(
        (r) => path === `/v1/payments/pay_fixture/refunds/${r.id}`,
      );
      if (result?.status === "pending") {
        result.status = "processed";
        providerPayment.amount_refunded += result.amount;
      }
    }
    if (!result)
      return new Response(
        JSON.stringify({ error: "Unexpected provider path" }),
        { status: 400 },
      );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const { app, pool } = require("../app");
  const embedded = embeddedPool(db);
  pool.query = embedded.query;
  pool.connect = embedded.connect;
  const server = app.listen(8000, "127.0.0.1", () =>
    console.log("Refund browser fixture ready on port 8000"),
  );
  process.on("SIGTERM", () =>
    server.close(async () => {
      await embedded.end();
      process.exit(0);
    }),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
