const { transaction } = require("./commerce");
const { fail } = require("./security");
module.exports = function (app, pool, security) {
  const route = (path, fn) =>
    app.delete(
      path,
      security.authorize(path, "delete"),
      async (req, res, next) => {
        try {
          res.json(
            await transaction(pool, async (c) => {
              const tenant = req.params.restaurant_id || req.user.restaurantId;
              await c.query(
                "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
                [tenant],
              );
              return fn(c, req, tenant);
            }),
          );
        } catch (e) {
          next(e);
        }
      },
    );
  async function idle(c, ids) {
    if (!ids.length) return;
    const active = await c.query(
      "SELECT id FROM orders WHERE table_id=ANY($1::text[]) AND status NOT IN ('Completed','Cancelled')",
      [ids],
    );
    const booked = await c.query(
      "SELECT id FROM reservations WHERE table_id=ANY($1::text[]) AND status IN ('pending','confirmed','success','seated')",
      [ids],
    );
    if (active.rows.length || booked.rows.length)
      throw fail(
        409,
        "Complete orders and resolve reservations before removing tables",
      );
  }
  route("/deleteTable/:table_id/:restaurant_id", async (c, req, t) => {
    await idle(c, [req.params.table_id]);
    await c.query(
      "DELETE FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2",
      [req.params.table_id, t],
    );
    return {
      success: true,
      message: "Table deleted",
      deletedTableId: req.params.table_id,
    };
  });
  route("/deleteArea/:area_id/:restaurant_id", async (c, req, t) => {
    const ids = (
      await c.query(
        "SELECT id FROM restaurant_tables WHERE area_id=$1 AND restaurant_id=$2",
        [req.params.area_id, t],
      )
    ).rows.map((r) => r.id);
    await idle(c, ids);
    await c.query(
      "DELETE FROM restaurant_tables WHERE area_id=$1 AND restaurant_id=$2",
      [req.params.area_id, t],
    );
    await c.query(
      "DELETE FROM restaurant_area WHERE id=$1 AND restaurant_id=$2",
      [req.params.area_id, t],
    );
    return {
      success: true,
      message: "Area deleted",
      deletedAreaId: req.params.area_id,
    };
  });
  route("/deleteMenuCategoryCompletly/:category_id", async (c, req, t) => {
    await c.query(
      "DELETE FROM restaurant_menu_items WHERE menu_category_id=$1 AND restaurant_id=$2",
      [req.params.category_id, t],
    );
    await c.query(
      "DELETE FROM restaurant_menu_category WHERE id=$1 AND restaurant_id=$2",
      [req.params.category_id, t],
    );
    return { message: "Category deleted" };
  });
  route("/superAdmin/deleteRestaurant/:restaurant_id", async (c, req, t) => {
    for (const table of [
      "orders",
      "payments",
      "reservations",
      "restaurant_staff",
      "restaurant_tables",
      "restaurant_area",
      "restaurant_menu_items",
      "restaurant_menu_category",
    ])
      if (
        (
          await c.query(
            `SELECT 1 FROM ${table} WHERE restaurant_id=$1 LIMIT 1`,
            [t],
          )
        ).rows.length
      )
        throw fail(
          409,
          "Restaurant has records. Deactivate it instead of deleting its history.",
        );
    const { rows } = await c.query(
      "DELETE FROM restaurant_admin WHERE id=$1 RETURNING id",
      [t],
    );
    if (!rows.length) throw fail(404, "Restaurant not found");
    return { message: "Empty restaurant account deleted" };
  });
};
