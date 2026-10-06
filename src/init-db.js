import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL no está configurada.");
  }

  const schemaPath = path.resolve("sql/schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");

  console.log("Conectando a PostgreSQL...");
  await pool.query("SELECT 1");
  console.log("Conexión OK. Ejecutando sql/schema.sql...");

  await pool.query(sql);

  console.log("Base inicializada correctamente.");
  console.log("Tablas y conceptos creados/verificados sin borrar información existente.");
}

main()
  .catch((error) => {
    console.error("Error inicializando la base:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
