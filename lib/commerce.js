const { randomUUID } = require("crypto");
const { fail } = require("./security");
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function money(v) {
  if (
    v === "" ||
    v === null ||
    typeof v === "boolean" ||
    !Number.isFinite(Number(v)) ||
    Number(v) < 0 ||
    Number(v) > 9999999
  )
    throw fail(400, "Invalid amount");
  return round(Number(v));
}
function totals(o) {
  const subtotal = money(o.total_price),
    discount = money(o.discount_amount || 0),
    tax = money(o.tax_amount || 0);
  if (discount > subtotal) throw fail(400, "Discount exceeds subtotal");
  return {
    subtotal,
    discount,
    tax,
    total: round(subtotal - discount + (o.tax_mode === "inclusive" ? 0 : tax)),
  };
}
function reservationTime(date, time) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
    !/^\d{2}:\d{2}(:\d{2})?$/.test(time || "")
  )
    throw fail(400, "Choose a valid date and time");
  const d = new Date(date + "T00:00:00Z"),
    [h, m, s = 0] = time.split(":").map(Number);
  if (
    Number.isNaN(d.getTime()) ||
    d.toISOString().slice(0, 10) !== date ||
    h > 23 ||
    m > 59 ||
    s > 59
  )
    throw fail(400, "Invalid date or time");
  return date + " " + time;
}
async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
function registerCommerce(app, pool, security) {
  const tz = process.env.RESTAURANT_TIMEZONE || "Asia/Kolkata";
  new Intl.DateTimeFormat("en", { timeZone: tz });
  const route = (method, path, fn, pub = false) =>
    app[method](
      path,
      ...(pub ? [] : [security.authorize(path, method)]),
      async (req, res, next) => {
        try {
          res.json(await fn(req));
        } catch (e) {
          next(e);
        }
      },
    );
  const lock = (c, id) =>
    c.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [id]);
  async function table(c, id, tenant) {
    if (!id) return null;
    const t = (
      await c.query(
        "SELECT * FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",
        [id, tenant],
      )
    ).rows[0];
    if (!t) throw fail(404, "Table not found");
    if (/^(false|no|inactive|disabled)$/i.test(t.is_active))
      throw fail(409, "Table unavailable");
    return t;
  }
  async function reserved(c, id) {
    return (
      (
        await c.query(
          "SELECT id FROM reservations WHERE table_id=$1 AND status IN ('pending','success','confirmed') AND date+time-INTERVAL '30 minutes' <= NOW() AT TIME ZONE $2 AND date+time+INTERVAL '2 hours' > NOW() AT TIME ZONE $2",
          [id, tz],
        )
      ).rows.length > 0
    );
  }
  async function syncTable(c, id) {
    if (!id) return;
    await c.query(
      `UPDATE restaurant_tables SET current_status=CASE WHEN EXISTS (SELECT 1 FROM orders WHERE table_id=$1 AND status NOT IN ('Completed','Cancelled') AND order_status NOT IN ('Completed','Cancelled')) THEN 'occupied' ELSE 'available' END,status=CASE WHEN EXISTS (SELECT 1 FROM orders WHERE table_id=$1 AND status NOT IN ('Completed','Cancelled') AND order_status NOT IN ('Completed','Cancelled')) THEN 'use' ELSE 'free' END,last_used_at=NOW() WHERE id=$1`,
      [id],
    );
  }
  async function getOrder(c, id, req) {
    const o = (
      await c.query(
        "SELECT * FROM orders WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",
        [id, req.user.restaurantId],
      )
    ).rows[0];
    if (!o) throw fail(404, "Order not found");
    if (
      ["guest", "customer"].includes(req.user.role) &&
      o.customer_id !== req.user.userId
    )
      throw fail(404, "Order not found");
    if (req.user.role === "waiter" && o.waiter_id !== req.user.userId)
      throw fail(403, "Order not assigned to you");
    return o;
  }
  async function editable(c, req) {
    const o = await getOrder(c, req.params.order_id, req);
    if (
      ["Completed", "Cancelled"].includes(o.status) ||
      ["Paid", "SUCCESS"].includes(o.payment_status)
    )
      throw fail(409, "Settled orders cannot be edited");
    if (
      (
        await c.query(
          "SELECT id FROM payments WHERE order_id=$1 AND payment_status IN ('Pending','INITIATED','PENDING_CONFIRMATION')",
          [o.id],
        )
      ).rows.length
    )
      throw fail(409, "Resolve the pending payment before editing");
    return o;
  }
  async function priceItems(c, input, tenant) {
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        throw fail(400, "Invalid items");
      }
    }
    if (!Array.isArray(input) || !input.length || input.length > 100)
      throw fail(400, "Choose 1–100 items");
    const ids = input.map((i) => i?.id);
    if (ids.some((id) => typeof id !== "string" || !id))
      throw fail(400, "Each item needs an ID");
    const menu = new Map(
      (
        await c.query(
          "SELECT * FROM restaurant_menu_items WHERE restaurant_id=$1 AND id=ANY($2::text[])",
          [tenant, ids],
        )
      ).rows.map((i) => [i.id, i]),
    );
    return input.map((i) => {
      const item = menu.get(i.id);
      if (!item || !/^(yes|true|available)$/i.test(item.availability))
        throw fail(409, "An item is unavailable");
      if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 100)
        throw fail(400, "Quantity must be 1–100");
      const price = money(item.price);
      return {
        id: item.id,
        quantity: i.quantity,
        price,
        cart_item_price: price,
        item_name: item.item_name,
        cart_item_name: item.item_name,
        cart_item_image: item.image_url,
      };
    });
  }
  route(
    "get",
    "/public/tables/:restaurant_id",
    async (req) => {
      await security.activeRestaurant(req.params.restaurant_id);
      const at =
        req.query.date || req.query.time
          ? reservationTime(req.query.date, req.query.time)
          : null;
      const { rows } = await pool.query(
        `SELECT t.id,t.name,t.seat_capacity,t.area_id,t.restaurant_id,
  CASE WHEN LOWER(t.is_active) IN ('false','no','inactive','disabled') THEN 'unavailable'
  WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.table_id=t.id AND r.status IN ('pending','success','confirmed') AND ($4::text IS NULL OR r.id<>$4)
    AND (CASE WHEN $2::text IS NULL THEN r.date+r.time-INTERVAL '30 minutes' <= NOW() AT TIME ZONE $3 AND r.date+r.time+INTERVAL '2 hours' > NOW() AT TIME ZONE $3
      ELSE r.date+r.time-INTERVAL '30 minutes' < $2::timestamp+INTERVAL '2 hours' AND r.date+r.time+INTERVAL '2 hours' > $2::timestamp-INTERVAL '30 minutes' END)) THEN 'reserved'
  WHEN ($2::text IS NULL OR $2::timestamp-INTERVAL '30 minutes' <= NOW() AT TIME ZONE $3) AND EXISTS (SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.status NOT IN ('Completed','Cancelled') AND o.order_status NOT IN ('Completed','Cancelled')) THEN 'occupied'
  ELSE 'available' END AS current_status FROM restaurant_tables t WHERE t.restaurant_id=$1 ORDER BY t.name`,
        [
          req.params.restaurant_id,
          at,
          tz,
          req.query.exclude_reservation_id || null,
        ],
      );
      return { tables: rows };
    },
    true,
  );
  route("post", "/addNewOrder", (req) =>
    transaction(pool, async (c) => {
      const b = req.body,
        tenant = req.user.restaurantId;
      await lock(c, tenant);
      const id = b.id || randomUUID();
      const old = (await c.query("SELECT * FROM orders WHERE id=$1", [id]))
        .rows[0];
      if (old) {
        if (
          old.restaurant_id !== tenant ||
          (req.user.role === "guest" && old.customer_id !== req.user.userId) ||
          (req.user.role === "waiter" && old.waiter_id !== req.user.userId)
        )
          throw fail(409, "Order ID exists");
        return { order: old, order_number: old.order_number };
      }
      const t = await table(
        c,
        req.user.role === "guest" ? req.user.tableId : b.table_id,
        tenant,
      );
      if (t && (await reserved(c, t.id)))
        throw fail(
          409,
          "Table is reserved. Ask staff to seat the reservation first.",
        );
      const items = await priceItems(c, b.items, tenant);
      const subtotal = round(
        items.reduce((sum, i) => sum + i.price * i.quantity, 0),
      );
      money(subtotal);
      const settings =
        (
          await c.query(
            "SELECT payment_settings FROM restaurant_admin WHERE id=$1",
            [tenant],
          )
        ).rows[0]?.payment_settings || {};
      const discount =
        req.user.role === "admin" ? money(b.discount_amount || 0) : 0;
      if (discount > subtotal) throw fail(400, "Discount exceeds subtotal");
      const tax =
        req.user.role === "admin"
          ? money(b.tax_amount || 0)
          : round(((subtotal - discount) * money(settings.taxRate || 0)) / 100);
      let waiter =
        req.user.role === "waiter"
          ? req.user.userId
          : req.user.role === "guest"
            ? null
            : b.waiter_id;
      if (!waiter)
        waiter =
          (
            await c.query(
              `SELECT s.id FROM restaurant_staff s LEFT JOIN orders o ON o.waiter_id=s.id AND o.status NOT IN ('Completed','Cancelled') WHERE s.restaurant_id=$1 AND LOWER(s.role) LIKE '%waiter%' AND LOWER(COALESCE(s.status,'active')) IN ('active','available','serving') GROUP BY s.id ORDER BY COUNT(o.id),s.id LIMIT 1`,
              [tenant],
            )
          ).rows[0]?.id || null;
      const number = (
        await c.query(
          `INSERT INTO restaurant_order_counters (restaurant_id,order_date,last_number) VALUES ($1,(NOW() AT TIME ZONE $2)::date,1) ON CONFLICT (restaurant_id,order_date) DO UPDATE SET last_number=restaurant_order_counters.last_number+1 RETURNING to_char(order_date,'MMDD')||'-'||last_number::text AS number`,
          [tenant, tz],
        )
      ).rows[0].number;
      const { rows } = await c.query(
        `INSERT INTO orders (id,restaurant_id,customer_id,table_id,table_name,items,total_price,discount_amount,tax_amount,status,order_status,waiter_id,order_number,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pending','KOT',$10,$11,$12) RETURNING *`,
        [
          id,
          tenant,
          req.user.role === "guest" ? req.user.userId : null,
          t?.id || null,
          t?.name || null,
          JSON.stringify(items),
          subtotal,
          discount,
          tax,
          waiter,
          number,
          b.note || null,
        ],
      );
      await syncTable(c, t?.id);
      return { order: rows[0], order_number: number, message: "Order created" };
    }),
  );
  const transition = (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const o = await getOrder(c, req.params.order_id, req);
      const desired =
        req.body.order_status || req.body.status || req.params.status;
      const allowed = {
        Pending: ["Confirmed", "Preparing", "Cancelled"],
        Confirmed: ["Preparing", "Cancelled"],
        Preparing: ["Ready", "Cancelled"],
        Ready: ["Completed", "Cancelled"],
        Completed: [],
        Cancelled: [],
      };
      if (desired === o.status) return { order: o };
      if (!allowed[o.status]?.includes(desired))
        throw fail(409, "Invalid order status transition");
      if (req.user.role === "kot" && !["Preparing", "Ready"].includes(desired))
        throw fail(403, "Kitchen may only prepare or mark ready");
      if (
        desired === "Completed" &&
        !["Paid", "SUCCESS"].includes(o.payment_status)
      )
        throw fail(409, "Confirm payment before completing");
      if (
        desired === "Cancelled" &&
        ["Paid", "SUCCESS"].includes(o.payment_status)
      )
        throw fail(409, "Paid orders require a refund");
      const { rows } = await c.query(
        "UPDATE orders SET status=$1,order_status=$2,updated_at=NOW() WHERE id=$3 RETURNING *",
        [desired, desired === "Confirmed" ? "KOT" : desired, o.id],
      );
      await syncTable(c, o.table_id);
      return { order: rows[0] };
    });
  route("put", "/updateStatus/:order_id/:status", transition);
  route("put", "/updateOrderStatus/:order_id", transition);
  route("patch", "/updateOrderStatus/:order_id", transition);
  route("delete", "/deleteOrder/:order_id", (req) =>
    transition({ ...req, body: { status: "Cancelled" } }),
  );
  route("post", "/addKOT/:order_id", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const o = await editable(c, req);
      const added = await priceItems(c, req.body.items, req.user.restaurantId);
      const old = typeof o.items === "string" ? JSON.parse(o.items) : o.items;
      const items = [...old, ...added];
      const subtotal = round(
        items.reduce(
          (sum, i) => sum + Number(i.price ?? i.cart_item_price) * i.quantity,
          0,
        ),
      );
      money(subtotal);
      const tax =
        o.tax_percent === null
          ? money(o.tax_amount || 0)
          : round(
              ((subtotal - money(o.discount_amount || 0)) *
                Number(o.tax_percent)) /
                (o.tax_mode === "inclusive"
                  ? 100 + Number(o.tax_percent)
                  : 100),
            );
      const pending = ["KOT", "Preparing"].includes(o.order_status)
        ? o.kot_items || old
        : [];
      const kot = [
        ...(typeof pending === "string" ? JSON.parse(pending) : pending),
        ...added,
      ];
      const { rows } = await c.query(
        "UPDATE orders SET items=$1,total_price=$2,tax_amount=$3,kot_items=$4,status='Confirmed',order_status='KOT',updated_at=NOW() WHERE id=$5 RETURNING *",
        [JSON.stringify(items), subtotal, tax, JSON.stringify(kot), o.id],
      );
      return { order: rows[0] };
    }),
  );
  route("patch", "/updateOrderDiscount/:order_id", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const o = await editable(c, req),
        type = req.body.discount_type,
        value = money(req.body.discount_value);
      if (
        !["flat", "percent"].includes(type) ||
        (type === "percent" && value > 100)
      )
        throw fail(400, "Invalid discount");
      const discount =
        type === "percent"
          ? round((Number(o.total_price) * value) / 100)
          : value;
      if (discount > Number(o.total_price))
        throw fail(400, "Discount exceeds subtotal");
      const tax =
        o.tax_percent === null
          ? money(o.tax_amount || 0)
          : round(
              ((Number(o.total_price) - discount) * Number(o.tax_percent)) /
                (o.tax_mode === "inclusive"
                  ? 100 + Number(o.tax_percent)
                  : 100),
            );
      const { rows } = await c.query(
        "UPDATE orders SET discount_amount=$1,tax_amount=$2,updated_at=NOW() WHERE id=$3 RETURNING *",
        [discount, tax, o.id],
      );
      return { order: rows[0] };
    }),
  );
  route("patch", "/updateOrderTax/:order_id", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const o = await editable(c, req),
        mode = req.body.tax_mode,
        rate = money(req.body.tax_percent);
      if (!["inclusive", "exclusive"].includes(mode) || rate > 100)
        throw fail(400, "Invalid tax");
      const amount = round(
        ((Number(o.total_price) - money(o.discount_amount || 0)) * rate) /
          (mode === "inclusive" ? 100 + rate : 100),
      );
      const { rows } = await c.query(
        "UPDATE orders SET tax_mode=$1,tax_percent=$2,tax_amount=$3,updated_at=NOW() WHERE id=$4 RETURNING *",
        [mode, rate, amount, o.id],
      );
      return { order: rows[0] };
    }),
  );
  route("get", "/generateBill/:order_id", async (req) => {
    const o = req.resource;
    const restaurant = (
      await pool.query(
        "SELECT restaurentname,branchaddress,phonenumber FROM restaurant_admin WHERE id=$1",
        [o.restaurant_id],
      )
    ).rows[0];
    return { bill: { ...o, ...totals(o), restaurant } };
  });
  const paid = (s) => ["Paid", "SUCCESS"].includes(s);
  async function settle(c, o, p, status) {
    if (paid(p.payment_status) && !paid(status))
      throw fail(409, "Confirmed payment cannot be reversed here");
    if (paid(status)) {
      if (o.status === "Cancelled") throw fail(409, "Order cancelled");
      if (Math.abs(Number(p.amount) - totals(o).total) > 0.005)
        throw fail(409, "Payment differs from bill");
      if (
        (
          await c.query(
            "SELECT id FROM payments WHERE order_id=$1 AND id<>$2 AND payment_status IN ('Paid','SUCCESS')",
            [o.id, p.id],
          )
        ).rows.length
      )
        throw fail(409, "Order already paid");
    }
    const r = await c.query(
      "UPDATE payments SET payment_status=$1,updated_at=NOW() WHERE id=$2 RETURNING *",
      [status, p.id],
    );
    if (paid(status)) {
      await c.query(
        "UPDATE orders SET payment_status='Paid',payment_method=$1,status='Completed',order_status='Completed',updated_at=NOW() WHERE id=$2",
        [p.payment_method, o.id],
      );
      await c.query(
        "UPDATE payments SET payment_status='Failed',updated_at=NOW() WHERE order_id=$1 AND id<>$2 AND payment_status IN ('Pending','INITIATED','PENDING_CONFIRMATION')",
        [o.id, p.id],
      );
      await syncTable(c, o.table_id);
    }
    return r.rows[0];
  }
  route("post", "/createPayment", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const o = await getOrder(c, req.body.order_id, req);
      if (o.status === "Cancelled") throw fail(409, "Order cancelled");
      const prior = (
        await c.query(
          "SELECT * FROM payments WHERE order_id=$1 AND payment_status IN ('Paid','SUCCESS','Pending','INITIATED','PENDING_CONFIRMATION') ORDER BY created_at DESC LIMIT 1",
          [o.id],
        )
      ).rows[0];
      if (prior) return { payment: prior };
      const method = req.body.payment_method || req.body.method;
      if (!["Cash", "UPI", "Card"].includes(method))
        throw fail(400, "Choose Cash, UPI or Card");
      const settings =
        (
          await c.query(
            "SELECT payment_settings FROM restaurant_admin WHERE id=$1",
            [o.restaurant_id],
          )
        ).rows[0]?.payment_settings || {};
      if (settings.paymentMethods?.[method.toLowerCase()] === false)
        throw fail(400, "Payment method disabled");
      if (["guest", "customer"].includes(req.user.role) && method === "Card")
        throw fail(400, "Pay by card at the counter");
      const status =
        ["admin", "waiter"].includes(req.user.role) &&
        paid(req.body.payment_status)
          ? "Paid"
          : "Pending";
      const { rows } = await c.query(
        `INSERT INTO payments (id,restaurant_id,order_id,order_number,table_id,table_name,amount,payment_method,payment_status,transaction_id,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending',$9,$10) RETURNING *`,
        [
          randomUUID(),
          o.restaurant_id,
          o.id,
          o.order_number,
          o.table_id,
          o.table_name,
          totals(o).total,
          method,
          req.body.transaction_id || null,
          req.body.notes || null,
        ],
      );
      return {
        payment:
          status === "Paid" ? await settle(c, o, rows[0], status) : rows[0],
      };
    }),
  );
  route("get", "/getPendingPayments/:restaurant_id", async (req) => ({
    payments: (
      await pool.query(
        "SELECT * FROM payments WHERE restaurant_id=$1 AND payment_status IN ('Pending','INITIATED','PENDING_CONFIRMATION') ORDER BY created_at",
        [req.user.restaurantId],
      )
    ).rows,
  }));
  route("put", "/updatePaymentStatus/:payment_id", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const p = (
        await c.query(
          "SELECT * FROM payments WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",
          [req.params.payment_id, req.user.restaurantId],
        )
      ).rows[0];
      if (!p) throw fail(404, "Payment not found");
      const status = req.body.payment_status;
      if (!["Paid", "SUCCESS", "Failed", "FAILED"].includes(status))
        throw fail(400, "Choose confirmed or failed");
      const o = await getOrder(c, p.order_id, req);
      return {
        payment: await settle(c, o, p, paid(status) ? "Paid" : "Failed"),
      };
    }),
  );
  route("put", "/updateOrderPaymentStatus/:order_id", async () => {
    throw fail(409, "Confirm the payment record using updatePaymentStatus");
  });
  route("post", "/restaurant_details/updatedTableStatus", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      await table(c, req.body.tableId, req.user.restaurantId);
      await syncTable(c, req.body.tableId);
      return { message: "Table status refreshed" };
    }),
  );
  async function reservation(req, update) {
    return transaction(pool, async (c) => {
      const tenant = req.user.restaurantId;
      await lock(c, tenant);
      const old = update
        ? (
            await c.query(
              "SELECT * FROM reservations WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",
              [req.params.id, tenant],
            )
          ).rows[0]
        : null;
      if (update && !old) throw fail(404, "Reservation not found");
      const b = { ...old, ...req.body },
        date = String(b.date).slice(0, 10),
        at = reservationTime(date, b.time),
        status = b.status || "pending";
      if (
        ![
          "pending",
          "success",
          "confirmed",
          "seated",
          "completed",
          "cancelled",
        ].includes(status)
      )
        throw fail(400, "Invalid reservation status");
      if (
        !b.customer_name ||
        !b.email ||
        !b.phone ||
        !Number.isInteger(Number(b.guests)) ||
        Number(b.guests) < 1
      )
        throw fail(400, "Complete reservation details");
      const t = await table(c, b.table_id, tenant);
      if (!t) throw fail(400, "Choose a table");
      if (Number(b.guests) > t.seat_capacity)
        throw fail(409, "Party exceeds table capacity");
      const id = update ? req.params.id : b.id || randomUUID();
      if (
        !["cancelled", "completed"].includes(status) &&
        (
          await c.query(
            "SELECT id FROM reservations WHERE table_id=$1 AND id<>$2 AND status IN ('pending','success','confirmed','seated') AND date+time-INTERVAL '30 minutes' < $3::timestamp+INTERVAL '2 hours' AND date+time+INTERVAL '2 hours' > $3::timestamp-INTERVAL '30 minutes'",
            [t.id, id, at],
          )
        ).rows.length
      )
        throw fail(409, "Table already reserved at that time");
      const values = [
        id,
        tenant,
        b.customer_name,
        b.email,
        b.phone,
        date,
        b.time,
        Number(b.guests),
        t.id,
        b.notes || "",
        status,
      ];
      const { rows } = await c.query(
        update
          ? "UPDATE reservations SET customer_name=$3,email=$4,phone=$5,date=$6,time=$7,guests=$8,table_id=$9,notes=$10,status=$11,updated_at=NOW() WHERE id=$1 AND restaurant_id=$2 RETURNING *"
          : "INSERT INTO reservations (id,restaurant_id,customer_name,email,phone,date,time,guests,table_id,notes,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        values,
      );
      return { reservation: rows[0] };
    });
  }
  route("post", "/addReservation", (req) => reservation(req, false));
  route("put", "/updateReservation/:id", (req) => reservation(req, true));
  route("delete", "/deleteReservation/:id", (req) =>
    transaction(pool, async (c) => {
      await lock(c, req.user.restaurantId);
      const r = await c.query(
        "UPDATE reservations SET status='cancelled',updated_at=NOW() WHERE id=$1 AND restaurant_id=$2 RETURNING *",
        [req.params.id, req.user.restaurantId],
      );
      if (!r.rows.length) throw fail(404, "Reservation not found");
      return { message: "Reservation cancelled" };
    }),
  );
}
module.exports = {
  registerCommerce,
  transaction,
  money,
  totals,
  reservationTime,
};
