const { orderView } = require("./order-view");
const { transaction } = require("./commerce");
const { fail } = require("./security");
module.exports = function (app, pool, security) {
  app.get(
    "/workspace",
    security.authorize("/workspace", "get"),
    async (req, res) => {
      const { restaurantId: id, role, userId } = req.user;
      const restaurant = (
        await pool.query("SELECT * FROM restaurant_admin WHERE id=$1", [id])
      ).rows[0];
      const menu = (
        await pool.query(
          "SELECT * FROM restaurant_menu_items WHERE restaurant_id=$1 ORDER BY item_name",
          [id],
        )
      ).rows;
      const categories = (
        await pool.query(
          "SELECT * FROM restaurant_menu_category WHERE restaurant_id=$1 ORDER BY menu_category_name",
          [id],
        )
      ).rows;
      const areas = (
        await pool.query(
          "SELECT * FROM restaurant_area WHERE restaurant_id=$1 ORDER BY area_name",
          [id],
        )
      ).rows;
      const tables = (
        await pool.query(
          "SELECT * FROM restaurant_tables WHERE restaurant_id=$1 ORDER BY name",
          [id],
        )
      ).rows;
      const orders = (
        await pool.query(
          `SELECT * FROM orders WHERE restaurant_id=$1 ${role === "waiter" ? "AND waiter_id=$2" : role === "kot" ? "AND status NOT IN ('Completed','Cancelled','Refunded')" : ""} ORDER BY created_at DESC`,
          role === "waiter" ? [id, userId] : [id],
        )
      ).rows.map((o) => orderView(o, menu));
      const staff = (
        await pool.query(
          role === "admin"
            ? "SELECT * FROM restaurant_staff WHERE restaurant_id=$1 ORDER BY name"
            : "SELECT id,name,role,status FROM restaurant_staff WHERE restaurant_id=$1 ORDER BY name",
          [id],
        )
      ).rows;
      const reservations =
        role === "admin"
          ? (
              await pool.query(
                "SELECT * FROM reservations WHERE restaurant_id=$1 ORDER BY date DESC,time",
                [id],
              )
            ).rows
          : [];
      const payments =
        role === "admin"
          ? (
              await pool.query(
                "SELECT * FROM payments WHERE restaurant_id=$1 ORDER BY created_at DESC",
                [id],
              )
            ).rows
          : role === "waiter"
            ? (
                await pool.query(
                  "SELECT p.* FROM payments p JOIN orders o ON p.order_id=o.id WHERE p.restaurant_id=$1 AND o.waiter_id=$2 ORDER BY p.created_at DESC",
                  [id, userId],
                )
              ).rows
            : [];
      const requests =
        role === "kot"
          ? []
          : (
              await pool.query(
                `SELECT * FROM waiter_requests WHERE restaurant_id=$1 AND status IN ('pending','assigned') ${role === "waiter" ? "AND assigned_waiter_id=$2" : ""} ORDER BY created_at`,
                role === "waiter" ? [id, userId] : [id],
              )
            ).rows;
      const calls =
        role === "kot"
          ? []
          : (
              await pool.query(
                `SELECT * FROM admin_calls WHERE restaurant_id=$1 AND status='pending' ${role === "waiter" ? "AND waiter_id=$2" : ""} ORDER BY created_at`,
                role === "waiter" ? [id, userId] : [id],
              )
            ).rows;
      res.json({
        restaurant:
          role === "admin"
            ? restaurant
            : {
                id: restaurant.id,
                restaurentname: restaurant.restaurentname,
                branchname: restaurant.branchname,
                branchaddress: restaurant.branchaddress,
                phonenumber: restaurant.phonenumber,
                payment_settings: restaurant.payment_settings,
              },
        menu,
        categories,
        areas,
        tables,
        orders,
        staff,
        reservations,
        payments,
        requests,
        calls,
        serverTime: new Date().toISOString(),
      });
    },
  );
  app.put(
    "/workspace/profile",
    security.authorize("/workspace/profile", "put"),
    async (req, res) => {
      const b = req.body;
      for (const k of [
        "name",
        "restaurentname",
        "phonenumber",
        "branchname",
        "branchaddress",
      ])
        if (typeof b[k] !== "string" || !b[k].trim())
          throw fail(400, "Complete the restaurant contact details.");
      await pool.query(
        "UPDATE restaurant_admin SET name=$1,restaurentname=$2,phonenumber=$3,branchname=$4,branchaddress=$5 WHERE id=$6",
        [
          b.name,
          b.restaurentname,
          b.phonenumber,
          b.branchname,
          b.branchaddress,
          req.user.restaurantId,
        ],
      );
      res.json({ message: "Restaurant profile saved" });
    },
  );
  app.patch(
    "/workspace/orders/:order_id/assignment",
    security.authorize("/workspace/orders/:order_id/assignment", "patch"),
    async (req, res) => {
      const order = await transaction(pool, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
          req.user.restaurantId,
        ]);
        const o = (
          await c.query(
            "SELECT * FROM orders WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",
            [req.params.order_id, req.user.restaurantId],
          )
        ).rows[0];
        if (!o) throw fail(404, "Order not found");
        if (["Completed", "Cancelled", "Refunded"].includes(o.status))
          throw fail(409, "Completed orders cannot be reassigned");
        if (req.body.waiter_id) {
          const w = (
            await c.query(
              "SELECT id FROM restaurant_staff WHERE id=$1 AND restaurant_id=$2 AND lower(role) LIKE '%waiter%' AND lower(coalesce(status,'active')) NOT IN ('inactive','disabled','suspended')",
              [req.body.waiter_id, req.user.restaurantId],
            )
          ).rows[0];
          if (!w) throw fail(400, "Choose an active waiter");
        }
        return (
          await c.query(
            "UPDATE orders SET waiter_id=$1,updated_at=NOW() WHERE id=$2 RETURNING *",
            [req.body.waiter_id || null, o.id],
          )
        ).rows[0];
      });
      res.json({ order });
    },
  );
  app.get(
    "/guest/requests",
    security.authorize("/guest/requests", "get"),
    async (req, res) =>
      res.json({
        requests: (
          await pool.query(
            "SELECT id,request_type,status,created_at FROM waiter_requests WHERE customer_id=$1 AND table_id=$2 AND status IN ('pending','assigned') ORDER BY created_at DESC",
            [req.user.userId, req.user.tableId],
          )
        ).rows,
      }),
  );
};
