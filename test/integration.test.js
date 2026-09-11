const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
let db,
  server,
  root,
  pool,
  admin,
  otherAdmin,
  guest,
  otherGuest,
  kitchen,
  waiter;
const secret = "test-only-signing-secret-at-least-thirty-two-bytes";
const sign = (role, userId, restaurantId = "r1", extra = {}) =>
  jwt.sign({ role, userId, restaurantId, ...extra }, secret, {
    algorithm: "HS256",
    expiresIn: "1h",
    issuer: "eathub",
    audience: "eathub-api",
  });
async function api(method, path, token, body) {
  const r = await fetch(root + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, body: data };
}
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(__dirname + "/schema.sql", "utf8"));
  await db.exec(
    fs.readFileSync(
      __dirname + "/../migrations/001_audit_integrity.sql",
      "utf8",
    ),
  );
  await db.exec(`INSERT INTO restaurant_admin(id,name,email,password,restaurentname,phonenumber,branchname,country,branchaddress) VALUES ('r1','Owner','one@test.invalid','hash','Test One','1','Main','India','Test Street'),('r2','Owner Two','two@test.invalid','hash','Test Two','2','Main','India','Test Street');
 INSERT INTO restaurant_area VALUES ('a1','Hall','r1'),('a2','Hall','r2');
 INSERT INTO restaurant_tables(id,name,seat_capacity,is_active,restaurant_id,area_id) VALUES ('t1','T1',4,'true','r1','a1'),('t2','T2',4,'true','r2','a2'),('t3','T3',4,'true','r1','a1');
 INSERT INTO restaurant_menu_category VALUES ('c1','Food','r1'),('c2','Food','r2');
 INSERT INTO restaurant_menu_items(id,item_name,item_category,item_dec,preparation_time,availability,price,menu_category_id,restaurant_id,category_name) VALUES ('m1','Meal','Veg','Test','10','Yes',100,'c1','r1','Food'),('m2','Meal','Veg','Test','10','Yes',200,'c2','r2','Food');
 INSERT INTO restaurant_staff(id,name,email,phone_number,role,restaurant_id,password,status) VALUES ('w1','Waiter','waiter@test.invalid','1','waiter','r1','hash','available'),('k1','Chef','chef@test.invalid','1','chef','r1','hash','active');`);
  await db.query("UPDATE restaurant_admin SET password=$1 WHERE id=$2", [
    await bcrypt.hash("test-password-only", 4),
    "r1",
  ]);
  process.env.DATABASE_URL = "postgres://never-used";
  process.env.JWT_SECRET = secret;
  const appModule = require("../app");
  pool = appModule.pool;
  const query = async (sql, args) => {
    const r = await db.query(sql, args);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  pool.query = query;
  // PGlite has one connection. Serialize transactions; a real multi-connection Postgres lock
  // load test remains a deployment check, not something this test pretends to emulate.
  let tail = Promise.resolve();
  pool.connect = async () => {
    let release;
    const prior = tail;
    tail = new Promise((r) => (release = r));
    await prior;
    let released = false;
    return {
      query,
      release() {
        assert.equal(released, false);
        released = true;
        release();
      },
    };
  };
  server = appModule.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  root = `http://127.0.0.1:${server.address().port}`;
  admin = sign("admin", "r1");
  otherAdmin = sign("admin", "r2", "r2");
  guest = sign("guest", "g1", "r1", { tableId: "t1" });
  otherGuest = sign("guest", "g2", "r1", { tableId: "t1" });
  kitchen = sign("kot", "k1");
  waiter = sign("waiter", "w1");
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (db) await db.close();
});
test("authorization rejects anonymous, forged, wrong-role and cross-tenant access", async () => {
  assert.equal((await api("GET", "/restaurant/r1")).status, 401);
  assert.equal((await api("GET", "/restaurant/r1", otherAdmin)).status, 403);
  assert.equal(
    (await api("GET", "/restaurant_details/getStaff/r1", guest)).status,
    403,
  );
  const forged = jwt.sign(
    { userId: "r1", role: "admin", restaurantId: "r1" },
    "10",
  );
  assert.equal((await api("GET", "/restaurant/r1", forged)).status, 401);
  const r = await api("GET", "/restaurant/r1", admin);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].password, undefined);
  assert.equal(
    (await api("GET", "/restaurant/r1", guest)).body[0].email,
    undefined,
  );
  assert.equal(
    (
      await api("PUT", "/restaurant_details/updateTable", admin, {
        table_id: "t1",
        area_id: "a2",
        restaurant_id: "r1",
      })
    ).status,
    404,
  );
  assert.equal(
    (await api("GET", "/waiterDetailsRestaurant/k1", kitchen)).status,
    200,
  );
  assert.equal(
    (await api("GET", "/waiterDetailsRestaurant/w1", kitchen)).status,
    403,
  );
  assert.equal((await api("POST", "/superAdmin/initialize")).status, 404);
});
test("login issues a scoped token and suspension invalidates it", async () => {
  const r = await api("POST", "/restaurantLogin", null, {
    email: "one@test.invalid",
    password: "test-password-only",
  });
  assert.equal(r.status, 200);
  const u = jwt.verify(r.body.token, secret, {
    issuer: "eathub",
    audience: "eathub-api",
  });
  assert.equal(u.role, "admin");
  assert.equal(u.restaurantId, "r1");
  await db.query("UPDATE restaurant_admin SET is_suspended=true WHERE id='r1'");
  assert.equal((await api("GET", "/restaurant/r1", r.body.token)).status, 403);
  await db.query(
    "UPDATE restaurant_admin SET is_suspended=false WHERE id='r1'",
  );
});
test("server pricing, idempotent numbering and guest order privacy", async () => {
  const r = await api("POST", "/addNewOrder", guest, {
    id: "o1",
    restaurant_id: "r1",
    table_id: "t1",
    items: [{ id: "m1", quantity: 2, price: 0.01 }],
    total_price: 0.02,
    discount_amount: 199,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number(r.body.order.total_price), 200);
  assert.equal(Number(r.body.order.discount_amount), 0);
  assert.match(r.body.order_number, /^\d{4}-1$/);
  assert.equal(r.body.order.waiter_id, "w1");
  assert.equal(
    (
      await api("POST", "/addNewOrder", guest, {
        id: "o1",
        items: [{ id: "m1", quantity: 2 }],
      })
    ).body.order_number,
    r.body.order_number,
  );
  assert.equal(
    (await api("GET", "/getOrderDetails/o1", otherGuest)).status,
    404,
  );
  assert.deepEqual(
    (await api("GET", "/getOrdersByTable/t1", otherGuest)).body.orders,
    [],
  );
  assert.equal(
    (
      await api("POST", "/addNewOrder", guest, {
        items: [{ id: "m2", quantity: 1 }],
      })
    ).status,
    409,
  );
  assert.equal((await api("POST", "/addNewOrder", guest, {})).status, 400);
  assert.equal((await api("GET", "/getOrderDetails/o1", guest)).status, 200);
});
test("discounts, inclusive tax, KOT and kitchen transitions", async () => {
  let r = await api("PATCH", "/updateOrderDiscount/o1", admin, {
    discount_type: "percent",
    discount_value: 10,
  });
  assert.equal(r.status, 200);
  assert.equal(Number(r.body.order.discount_amount), 20);
  r = await api("PATCH", "/updateOrderTax/o1", admin, {
    tax_mode: "inclusive",
    tax_percent: 5,
  });
  assert.equal(r.status, 200);
  assert.equal(Number(r.body.order.tax_amount), 8.57);
  r = await api("POST", "/addKOT/o1", admin, {
    items: [{ id: "m1", quantity: 1 }],
  });
  assert.equal(r.status, 200);
  assert.equal(Number(r.body.order.total_price), 300);
  assert.equal(
    (await api("GET", "/generateBill/o1", admin)).body.bill.total,
    280,
  );
  assert.equal(
    (
      await api("PUT", "/updateOrderStatus/o1", kitchen, {
        order_status: "Completed",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api("PUT", "/updateOrderStatus/o1", kitchen, {
        order_status: "Preparing",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("PUT", "/updateOrderStatus/o1", kitchen, {
        order_status: "Ready",
      })
    ).status,
    200,
  );
});
test("customer cannot self-confirm; staff settle exactly once and release the table", async () => {
  let r = await api("POST", "/createPayment", guest, {
    order_id: "o1",
    restaurant_id: "r1",
    payment_method: "UPI",
    payment_status: "Paid",
    amount: 1,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payment.payment_status, "Pending");
  assert.equal(Number(r.body.payment.amount), 280);
  const id = r.body.payment.id;
  assert.equal(
    (
      await api("POST", "/createPayment", guest, {
        order_id: "o1",
        payment_method: "UPI",
      })
    ).body.payment.id,
    id,
  );
  assert.equal(
    (
      await api("PUT", `/updatePaymentStatus/${id}`, guest, {
        payment_status: "Paid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("PUT", `/updatePaymentStatus/${id}`, otherAdmin, {
        payment_status: "Paid",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await api("PUT", `/updatePaymentStatus/${id}`, admin, {
        payment_status: "Paid",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("PUT", `/updatePaymentStatus/${id}`, admin, {
        payment_status: "Paid",
      })
    ).status,
    200,
  );
  const o = (await api("GET", "/getOrderDetails/o1", guest)).body.order[0];
  assert.equal(o.status, "Completed");
  assert.equal(o.payment_status, "Paid");
  assert.equal(
    (
      await db.query(
        "SELECT current_status FROM restaurant_tables WHERE id='t1'",
      )
    ).rows[0].current_status,
    "available",
  );
  assert.equal((await api("DELETE", "/deleteOrder/o1", admin)).status, 409);
});
test("reservation overlap crosses midnight; seating unblocks ordering", async () => {
  const b = {
    id: "res1",
    restaurant_id: "r1",
    customer_name: "Guest",
    email: "guest@test.invalid",
    phone: "1",
    date: "2030-01-01",
    time: "23:30",
    guests: 2,
    table_id: "t3",
    status: "confirmed",
  };
  let r = await api("POST", "/addReservation", admin, b);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    (
      await api("POST", "/addReservation", admin, {
        ...b,
        id: "res2",
        date: "2030-01-02",
        time: "00:30",
      })
    ).status,
    409,
  );
  r = await api("GET", "/public/tables/r1?date=2030-01-02&time=00:30");
  assert.equal(
    r.body.tables.find((t) => t.id === "t3").current_status,
    "reserved",
  );
  const now = (
    await db.query(
      "SELECT to_char(NOW() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date,to_char(NOW() AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS time",
    )
  ).rows[0];
  await db.query("UPDATE reservations SET date=$1,time=$2 WHERE id=$3", [
    now.date,
    now.time,
    "res1",
  ]);
  assert.equal(
    (
      await api("POST", "/addNewOrder", admin, {
        table_id: "t3",
        items: [{ id: "m1", quantity: 1 }],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api("PUT", "/updateReservation/res1", admin, {
        ...b,
        ...now,
        status: "seated",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("POST", "/addNewOrder", admin, {
        id: "o2",
        table_id: "t3",
        items: [{ id: "m1", quantity: 1 }],
      })
    ).status,
    200,
  );
});
test("parallel requests obtain different counter values and active tables cannot be removed", async () => {
  const r = await Promise.all(
    [1, 2, 3].map((i) =>
      api("POST", "/addNewOrder", admin, {
        id: `parallel-${i}`,
        items: [{ id: "m1", quantity: 1 }],
      }),
    ),
  );
  r.forEach((x) => assert.equal(x.status, 200));
  assert.equal(new Set(r.map((x) => x.body.order_number)).size, 3);
  assert.equal((await api("DELETE", "/deleteTable/t3/r1", admin)).status, 409);
});
test("mixed-tenant bulk requests are rejected before any rows are inserted", async () => {
  const r = await api("POST", "/restaurant_details/addAreas", admin, [
    { area_id: "bulk1", area_name: "New", restaurant_id: "r1" },
    { area_id: "bulk2", area_name: "Other", restaurant_id: "r2" },
  ]);
  assert.equal(r.status, 403);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM restaurant_area WHERE id IN ('bulk1','bulk2')",
      )
    ).rows.length,
    0,
  );
});
test("extra KOT after ready sends only the new items to the kitchen", async () => {
  assert.equal(
    (
      await api("POST", "/addNewOrder", admin, {
        id: "kot-test",
        items: [{ id: "m1", quantity: 1 }],
      })
    ).status,
    200,
  );
  await api("PUT", "/updateOrderStatus/kot-test", kitchen, {
    order_status: "Preparing",
  });
  await api("PUT", "/updateOrderStatus/kot-test", kitchen, {
    order_status: "Ready",
  });
  assert.equal(
    (
      await api("POST", "/addKOT/kot-test", admin, {
        items: [{ id: "m1", quantity: 2 }],
      })
    ).status,
    200,
  );
  const orders = (await api("GET", "/getOrdersKitchen/r1", kitchen)).body.order;
  const o = orders.find((x) => x.id === "kot-test");
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].quantity, 2);
  const bill = (await api("GET", "/generateBill/kot-test", admin)).body.bill;
  assert.equal(bill.items.length, 2);
  assert.equal(bill.total, 300);
});
