const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { applyPendingMigrations } = require("../lib/migrations");
const { Pool } = require("pg");
const { checkDatabase } = require("../lib/readiness");
async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL in backend .env first.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });
  try {
    if (process.argv.includes("--migrate")) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(74147002)");
        await applyPendingMigrations(c);
        await checkDatabase(c);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    await checkDatabase(pool);
    console.log("EatHub database is ready.");
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(
    `Database setup failed (${e.code || "configuration"}): ${e.message}`,
  );
  process.exitCode = 1;
});
