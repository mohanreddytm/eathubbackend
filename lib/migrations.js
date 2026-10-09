const fs = require("node:fs");
const path = require("node:path");
const migrations = [
  [2, "002_schema_compatibility.sql"],
  [3, "003_refunds.sql"],
];

// The caller owns BEGIN/COMMIT and, in production, the advisory migration lock.
async function applyPendingMigrations(client) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS eathub_schema_versions(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await client.query("SELECT version FROM eathub_schema_versions")).rows.map(
      (r) => r.version,
    ),
  );
  for (const [version, file] of migrations) {
    if (!applied.has(version)) {
      const sql = fs.readFileSync(
        path.join(__dirname, "../migrations", file),
        "utf8",
      );
      // PGlite's exec supports multiple statements; pg uses query.
      if (client.exec) await client.exec(sql);
      else await client.query(sql);
    }
  }
}
module.exports = { applyPendingMigrations };
