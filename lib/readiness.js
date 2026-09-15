const required = {
  orders: [
    "order_number",
    "payment_status",
    "kot_items",
    "tax_mode",
    "tax_percent",
  ],
  payments: ["provider_order_id"],
  restaurant_tables: ["current_status"],
  restaurant_order_counters: ["last_number"],
};
async function checkDatabase(pool) {
  const { rows } = await pool.query(
    "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])",
    [Object.keys(required)],
  );
  const missing = Object.entries(required).flatMap(([table, cols]) =>
    cols
      .filter(
        (col) =>
          !rows.some((r) => r.table_name === table && r.column_name === col),
      )
      .map((col) => `${table}.${col}`),
  );
  const number = rows.find(
    (r) => r.table_name === "orders" && r.column_name === "order_number",
  );
  if (number && !["text", "character varying"].includes(number.data_type))
    missing.push("orders.order_number must be text");
  if (missing.length)
    throw Object.assign(
      new Error(
        `Database upgrade required: ${missing.join(", ")}. Run npm run db:migrate in the backend directory.`,
      ),
      { code: "SCHEMA_NOT_READY" },
    );
  return true;
}
module.exports = { checkDatabase };
