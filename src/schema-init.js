import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "./db.js";

export const SCHEMA_FILES = ["sql/schema.sql", "sql/workflow.sql", "sql/finance.sql"];
// Arbitrary constant: every instance takes the same lock, so only one applies changes.
const MIGRATION_LOCK = 724190311;

/**
 * Applies the SQL files only when their content changed since the last successful run.
 * The files stay idempotent, but a normal restart no longer rewrites constraints or
 * triggers (which locks large tables), and concurrent instances wait for each other.
 */
export async function ensureSchema({ db = pool, files = SCHEMA_FILES, log = console.log } = {}) {
  if (db === pool && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL no está configurada.");
  }
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = new Map((await client.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum.trim()]));
    // A change in an earlier file re-applies the later ones too: they may depend on it.
    let forceRest = false;
    for (const file of files) {
      const sql = await fs.readFile(path.resolve(file), "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      if (!forceRest && applied.get(file) === checksum) continue;
      forceRest = true;
      log(`Aplicando ${file}…`);
      // Each SQL file runs inside its own BEGIN/COMMIT; it is recorded only after success.
      try {
        await client.query(sql);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        error.message = `${file}: ${error.message}`;
        throw error;
      }
      await client.query(
        `INSERT INTO schema_migrations(name, checksum) VALUES($1,$2)
         ON CONFLICT(name) DO UPDATE SET checksum=EXCLUDED.checksum, applied_at=NOW()`,
        [file, checksum]
      );
    }
    log(forceRest ? "Esquema PostgreSQL actualizado." : "Esquema PostgreSQL al día (sin cambios).");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
