const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { PGlite } = require("@electric-sql/pglite");
const { checkDatabase } = require("../lib/readiness");
const schema = fs.readFileSync(__dirname + "/schema.sql", "utf8"),
  upgrade = fs.readFileSync(
    __dirname + "/../migrations/002_schema_compatibility.sql",
    "utf8",
  );
test("integer order numbers upgrade without losing history; reruns preserve the counter", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec(
      "INSERT INTO restaurant_admin(id,name,email,password,restaurentname,phonenumber,branchname,country,branchaddress) VALUES('legacy','Owner','legacy@test.invalid','hash','Legacy','1','Main','India','Street'); INSERT INTO orders(id,restaurant_id,items,total_price,tax_amount,discount_amount,status,order_status,order_number) VALUES('old','legacy','[]','259','','0','preparing','Preparing',7)",
    );
    await assert.rejects(() => checkDatabase(db), /Database upgrade required/);
    await db.exec("BEGIN;" + upgrade + "COMMIT;");
    await require("../lib/migrations").applyPendingMigrations(db);
    await checkDatabase(db);
    let o = (await db.query("SELECT * FROM orders WHERE id='old'")).rows[0];
    assert.equal(o.order_number, "7");
    assert.equal(Number(o.total_price), 259);
    assert.equal(o.status, "Preparing");
    await db.query(
      "UPDATE restaurant_order_counters SET last_number=11 WHERE restaurant_id='legacy'",
    );
    await db.exec("BEGIN;" + upgrade + "COMMIT;");
    assert.equal(
      (
        await db.query(
          "SELECT last_number FROM restaurant_order_counters WHERE restaurant_id='legacy'",
        )
      ).rows[0].last_number,
      11,
    );
    assert.equal(
      (await db.query("SELECT count(*) n FROM orders")).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});
test("a database that ran audit migration 001 also upgrades safely", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      schema
        .replaceAll("order_number integer", "order_number varchar(32)")
        .replace(
          "reservation_info jsonb",
          "reservation_info jsonb,current_status text",
        ),
    );
    await db.exec(
      fs.readFileSync(
        __dirname + "/../migrations/001_audit_integrity.sql",
        "utf8",
      ),
    );
    await db.exec("BEGIN;" + upgrade + "COMMIT;");
    await require("../lib/migrations").applyPendingMigrations(db);
    await checkDatabase(db);
    assert.equal(
      (await db.query("SELECT version FROM eathub_schema_versions")).rows[0]
        .version,
      2,
    );
  } finally {
    await db.close();
  }
});
