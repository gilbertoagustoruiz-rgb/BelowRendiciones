import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

export async function ensureSchema() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL no está configurada.");
  }

  const schemaPath = path.resolve("sql/schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");

  await pool.query("SELECT 1");
  await pool.query(sql);

  console.log("Esquema PostgreSQL verificado/inicializado correctamente.");
}
