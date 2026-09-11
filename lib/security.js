const { randomUUID } = require("crypto");
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (value) =>
  Array.isArray(value)
    ? value.map(clean)
    : value && typeof value === "object" && !(value instanceof Date)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(
              ([k]) => !["password", "password_hash", "details"].includes(k),
            )
            .map(([k, v]) => [k, clean(v)]),
        )
      : value;
const policies = {};
const set = (paths, roles, resource) =>
  paths.split(" ").forEach((p) => (policies[p] = { roles, resource }));
set(
  "/getOrderRestaurant/:restaurant_id /getPayments/:restaurant_id /getPendingPayments/:restaurant_id /getReservations/:restaurant_id /getAdminCallsRestaurant/:restaurant_id",
  ["admin"],
);
set(
  "/getWaitersWithStatus/:restaurant_id /restaurant_messages/:restaurant_id /restaurant_messages",
  ["admin", "waiter"],
);
set("/getPendingWaiterRequests/:restaurant_id", ["admin"]);
set("/getOrdersKitchen/:restaurant_id", ["admin", "kot"]);
set(
  "/getMenuItems/:restaurant_id /restaurant_details/getMenuCategory/:restaurant_id /getPaymentSettings/:restaurant_id /getDisplaySettings/:restaurant_id /restaurant/:id",
  ["admin", "waiter", "kot", "guest"],
);
set("/getAreas/:restaurant_id", ["admin", "waiter", "kot"]);
set(
  "/getTables/:area_id",
  ["admin", "waiter", "kot"],
  ["restaurant_area", "area_id"],
);
set(
  "/getTableName/:table_id",
  ["admin", "waiter", "kot", "guest"],
  ["restaurant_tables", "table_id"],
);
set(
  "/getOrdersByTable/:table_id",
  ["admin", "waiter", "guest"],
  ["restaurant_tables", "table_id"],
);
set("/getOrderCustomer/:customer_id", ["customer"]);
set(
  "/getOrderDetails/:order_id /generateBill/:order_id /createPayment",
  ["admin", "waiter", "guest", "customer"],
  ["orders", "order_id"],
);
set(
  "/updateOrderStatus/:order_id",
  ["admin", "waiter", "kot"],
  ["orders", "order_id"],
);
set(
  "/updateStatus/:order_id/:status /addKOT/:order_id /deleteOrder/:order_id /updateOrderDiscount/:order_id /updateOrderTax/:order_id /updateOrderPaymentStatus/:order_id",
  ["admin", "waiter"],
  ["orders", "order_id"],
);
set(
  "/updatePaymentStatus/:payment_id",
  ["admin", "waiter"],
  ["payments", "payment_id"],
);
set(
  "/getOrdersWaiter/:waiter_id /getPendingAdminCallsWaiter/:waiter_id /updateWaiterStatus/:waiter_id",
  ["admin", "waiter"],
  ["restaurant_staff", "waiter_id"],
);
set(
  "/waiterDetailsRestaurant/:waiter_id",
  ["admin", "waiter", "kot"],
  ["restaurant_staff", "waiter_id"],
);
set("/addNewOrder /createWaiterRequest", ["admin", "waiter", "guest"]);
set(
  "/completeWaiterRequest/:request_id",
  ["admin", "waiter"],
  ["waiter_requests", "request_id"],
);
set(
  "/assignWaiterToRequest/:request_id",
  ["admin"],
  ["waiter_requests", "request_id"],
);
set("/updateAdminCallStatus/:id", ["admin", "waiter"], ["admin_calls", "id"]);
set(
  "/updateReservation/:id /deleteReservation/:id",
  ["admin"],
  ["reservations", "id"],
);
set(
  "/deleteMenuCategoryCompletly/:category_id",
  ["admin"],
  ["restaurant_menu_category", "category_id"],
);
set(
  "/restaurant_details/updateMenuCategoryName",
  ["admin"],
  ["restaurant_menu_category", "id"],
);
set(
  "/restaurant_details/updateStaff /restaurant_details/deleteStaff/:staff_id/:restaurant_id",
  ["admin"],
  ["restaurant_staff", "staff_id"],
);
set(
  "/restaurant_details/updateArea /deleteArea/:area_id/:restaurant_id",
  ["admin"],
  ["restaurant_area", "area_id"],
);
set(
  "/restaurant_details/updateTable /deleteTable/:table_id/:restaurant_id",
  ["admin"],
  ["restaurant_tables", "table_id"],
);
set(
  "/restaurant_details/updateMenuItem /deleteMenuItem/:item_id/:restaurant_id",
  ["admin"],
  ["restaurant_menu_items", "item_id"],
);
function createSecurity(pool, jwt, secret) {
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error("JWT_SECRET must contain at least 32 random bytes");
  const options = {
    algorithm: "HS256",
    issuer: "eathub",
    audience: "eathub-api",
  };
  const sign = (claims) =>
    jwt.sign(claims, secret, {
      ...options,
      expiresIn: claims.role === "guest" ? "8h" : "12h",
    });
  async function activeRestaurant(id) {
    const { rows } = await pool.query(
      "SELECT id,name,is_active,is_suspended FROM restaurant_admin WHERE id=$1",
      [id],
    );
    if (!rows[0] || !rows[0].is_active || rows[0].is_suspended)
      throw fail(403, "Restaurant unavailable");
    return rows[0];
  }
  async function owned(table, id, tenant) {
    if (!id) throw fail(400, "Missing resource ID");
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [
      id,
    ]);
    if (!rows[0] || rows[0].restaurant_id !== tenant)
      throw fail(404, "Resource not found");
    return rows[0];
  }
  async function authenticate(req) {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw fail(401, "Please sign in");
    let u;
    try {
      u = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        issuer: "eathub",
        audience: "eathub-api",
      });
    } catch {
      throw fail(401, "Session expired. Please sign in again");
    }
    if (!u.userId || !u.role) throw fail(401, "Invalid session");
    if (["super_admin", "customer"].includes(u.role)) {
      const table = u.role === "customer" ? "customer_details" : "super_admin";
      if (
        !(await pool.query(`SELECT id FROM ${table} WHERE id=$1`, [u.userId]))
          .rows.length
      )
        throw fail(401, "Account unavailable");
    } else if (["admin", "waiter", "kot", "guest"].includes(u.role)) {
      await activeRestaurant(u.restaurantId);
      if (u.role === "admin" && u.userId !== u.restaurantId)
        throw fail(403, "Invalid tenant session");
      if (["waiter", "kot"].includes(u.role)) {
        const s = await owned("restaurant_staff", u.userId, u.restaurantId);
        if (
          /^(inactive|disabled|suspended)$/i.test(s.status) ||
          (u.role === "waiter"
            ? !/waiter/i.test(s.role)
            : !/chef|kitchen/i.test(s.role))
        )
          throw fail(403, "Staff account unavailable");
        u.name = s.name;
      }
    } else throw fail(403, "Invalid role");
    req.user = u;
    return u;
  }
  const authorize = (rawPath, method) => async (req, res, next) => {
    try {
      const path = rawPath.replace(/\/$/, "");
      const u = await authenticate(req);
      if (
        path.startsWith("/superAdmin/") ||
        (path === "/restaurant" && method === "get")
      ) {
        if (u.role !== "super_admin")
          throw fail(403, "Super admin access required");
        req.superAdmin = u;
        return next();
      }
      const rule = policies[path] || { roles: ["admin"] };
      if (!rule.roles.includes(u.role)) throw fail(403, "Access denied");
      const b = req.body || {},
        records = Array.isArray(b) ? b : [b];
      // Customer accounts are supported for historical own-order reads; QR users use scoped guest sessions.
      if (u.role === "customer" && rule.resource?.[0] === "orders") {
        const id = req.params.order_id || b.order_id;
        const row = (
          await pool.query(
            "SELECT * FROM orders WHERE id=$1 AND customer_id=$2",
            [id, u.userId],
          )
        ).rows[0];
        if (!row) throw fail(404, "Order not found");
        u.restaurantId = row.restaurant_id;
        await activeRestaurant(u.restaurantId);
      }
      for (const record of [req.params || {}, ...records])
        if (record?.restaurant_id && record.restaurant_id !== u.restaurantId)
          throw fail(403, "Restaurant access denied");
      if (path === "/restaurant/:id" && req.params.id !== u.restaurantId)
        throw fail(403, "Restaurant access denied");
      if (
        path === "/getOrderCustomer/:customer_id" &&
        req.params.customer_id !== u.userId
      )
        throw fail(403, "Access denied");
      if (rule.resource) {
        const [table, key] = rule.resource;
        const row = await owned(
          table,
          req.params[key] || b[key],
          u.restaurantId,
        );
        req.resource = row;
        if (
          u.role === "guest" &&
          ((table === "orders" && row.customer_id !== u.userId) ||
            (table === "restaurant_tables" && row.id !== u.tableId))
        )
          throw fail(404, "Resource not found");
        if (
          u.role === "kot" &&
          table === "restaurant_staff" &&
          row.id !== u.userId
        )
          throw fail(403, "Access denied");
        if (u.role === "waiter") {
          const owner =
            table === "restaurant_staff"
              ? row.id
              : ["orders", "admin_calls"].includes(table)
                ? row.waiter_id
                : table === "waiter_requests"
                  ? row.assigned_waiter_id
                  : u.userId;
          if (owner !== u.userId)
            throw fail(403, "Item is not assigned to you");
        }
      }
      if (u.role === "guest") delete b.waiter_id;
      const links = {
        table_id: "restaurant_tables",
        tableId: "restaurant_tables",
        area_id: "restaurant_area",
        item_menu_category_id: "restaurant_menu_category",
        waiter_id: "restaurant_staff",
        assigned_waiter_id: "restaurant_staff",
      };
      for (const record of records)
        for (const [key, table] of Object.entries(links)) {
          if (
            !record?.[key] ||
            (key === "table_id" && path === "/restaurant_details/addTable") ||
            (key === "area_id" && path === "/restaurant_details/addAreas")
          )
            continue;
          const row = await owned(table, record[key], u.restaurantId);
          if (table === "restaurant_staff" && !/waiter/i.test(row.role))
            throw fail(400, "Choose a waiter");
          if (
            u.role === "guest" &&
            table === "restaurant_tables" &&
            row.id !== u.tableId
          )
            throw fail(403, "Table access denied");
        }
      if (path === "/restaurant_messages")
        Object.assign(b, {
          sender_id: u.userId,
          sender_role: u.role,
          sender_name: u.name || null,
        });
      if (path === "/createAdminCall")
        Object.assign(b, { admin_id: u.userId, admin_name: u.name || null });
      if (path === "/createWaiterRequest" && u.role === "guest")
        Object.assign(b, { customer_id: u.userId, table_id: u.tableId });
      next();
    } catch (e) {
      next(e);
    }
  };
  const guestSession = async (req, res, next) => {
    try {
      const { restaurant_id, table_id } = req.body;
      await activeRestaurant(restaurant_id);
      const t = await owned("restaurant_tables", table_id, restaurant_id);
      if (/^(false|no|inactive|disabled)$/i.test(t.is_active))
        throw fail(409, "Table unavailable");
      res.json({
        token: sign({
          userId: randomUUID(),
          role: "guest",
          restaurantId: restaurant_id,
          tableId: table_id,
        }),
      });
    } catch (e) {
      next(e);
    }
  };
  return { authorize, sign, activeRestaurant, owned, guestSession };
}
module.exports = { createSecurity, fail, clean };
