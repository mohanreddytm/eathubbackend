// Fictional, ephemeral local data. This server never connects to Neon.
const fs = require("fs"),
  path = require("path"),
  { randomBytes } = require("crypto");
const { PGlite } = require("@electric-sql/pglite");
const { embeddedPool } = require("../lib/embedded-pool");
async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo mode is only for local development.");
  process.env.DATABASE_URL = "postgres://local-demo-unused";
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.PORT = process.env.DEMO_PORT || "8000";
  const db = new PGlite();
  await db.exec(
    fs.readFileSync(path.join(__dirname, "../test/schema.sql"), "utf8"),
  );
  await require("../lib/migrations").applyPendingMigrations(db);
  const hash = await require("bcrypt").hash("EatHubDemo123!", 10);
  await db.query(
    "INSERT INTO restaurant_admin(id,name,email,password,restaurentname,phonenumber,branchname,country,branchaddress,payment_settings) VALUES('demo','Demo owner','admin@demo.invalid',$1,'Olive & Ember','0000000000','Garden branch','India','Demo address', '{\"taxRate\":5,\"paymentMethods\":{\"cash\":true,\"upi\":true,\"card\":true}}')",
    [hash],
  );
  await db.exec(
    "INSERT INTO restaurant_area VALUES('terrace','Garden terrace','demo'),('dining','Main dining','demo'); INSERT INTO restaurant_menu_category VALUES('starters','Starters','demo'),('mains','Mains','demo'),('drinks','Drinks','demo');",
  );
  for (let n = 1; n <= 8; n++)
    await db.query(
      "INSERT INTO restaurant_tables(id,name,seat_capacity,is_active,restaurant_id,area_id) VALUES($1,$2,$3,'true','demo',$4)",
      [
        `table${n}`,
        `T${String(n).padStart(2, "0")}`,
        n < 5 ? 4 : 2,
        n < 5 ? "dining" : "terrace",
      ],
    );
  for (const [id, name, role, email] of [
    ["waiter", "Asha", "Waiter", "waiter@demo.invalid"],
    ["chef", "Arjun", "Chef", "kitchen@demo.invalid"],
  ])
    await db.query(
      "INSERT INTO restaurant_staff(id,name,email,phone_number,role,restaurant_id,password,status) VALUES($1,$2,$3,'0000000000',$4,'demo',$5,'active')",
      [id, name, email, role, hash],
    );
  const dishes = [
    [
      "bruschetta",
      "Garden bruschetta",
      189,
      "starters",
      "Toasted sourdough, tomato, and basil",
      "photo-1572695157366-5e585ab2b69f",
    ],
    [
      "burger",
      "Classic chicken burger",
      299,
      "mains",
      "Grilled chicken, crisp lettuce, and house sauce",
      "photo-1568901346375-23c9450c58cd",
    ],
    [
      "pasta",
      "Creamy mushroom pasta",
      329,
      "mains",
      "Fresh mushrooms with a creamy parmesan sauce",
      "photo-1473093226795-af9932fe5856",
    ],
    [
      "salad",
      "Harvest salad",
      219,
      "starters",
      "Seasonal greens, avocado, and lemon dressing",
      "photo-1512621776951-a57141f2eefd",
    ],
    [
      "pizza",
      "Margherita pizza",
      349,
      "mains",
      "Tomato, mozzarella, and fresh basil",
      "photo-1574071318508-1cdbab80d002",
    ],
    [
      "pancake",
      "Buttermilk pancakes",
      199,
      "starters",
      "Fluffy pancakes with maple syrup",
      "photo-1528207776546-365bb710ee93",
    ],
    [
      "coffee",
      "Iced latte",
      149,
      "drinks",
      "Espresso and chilled milk over ice",
      "photo-1461023058943-07fcbe16d735",
    ],
    [
      "juice",
      "Fresh orange juice",
      129,
      "drinks",
      "Freshly squeezed oranges",
      "photo-1613478223719-2ab802602423",
    ],
  ];
  for (const [id, name, price, cat, description, image] of dishes)
    await db.query(
      "INSERT INTO restaurant_menu_items(id,item_name,item_category,item_dec,preparation_time,availability,image_url,price,menu_category_id,restaurant_id,category_name) VALUES($1,$2,$3,$4,'15','Yes',$5,$6,$7,'demo',$8)",
      [
        id,
        name,
        id === "burger" ? "Non-Veg" : "Veg",
        description,
        `/demo-menu/${id}.jpg`,
        price,
        cat,
        { starters: "Starters", mains: "Mains", drinks: "Drinks" }[cat],
      ],
    );
  await db.query(
    "INSERT INTO super_admin(id,email,password,name) VALUES('super','super@demo.invalid',$1,'Demo platform admin')",
    [hash],
  );
  const { app, pool } = require("../app");
  const adapter = embeddedPool(db);
  pool.query = adapter.query;
  pool.connect = adapter.connect;
  const server = app.listen(Number(process.env.PORT), "127.0.0.1", () =>
    console.log(
      `Local demo API ready on http://localhost:${process.env.PORT}. Accounts: admin@demo.invalid, waiter@demo.invalid, kitchen@demo.invalid, super@demo.invalid. Password: EatHubDemo123! Data resets when stopped.`,
    ),
  );
  async function close() {
    server.close();
    await pool.end();
    await adapter.end();
    process.exit(0);
  }
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
