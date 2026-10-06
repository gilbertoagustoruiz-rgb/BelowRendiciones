import "dotenv/config";
import { ensureSchema } from "./schema-init.js";
import { pool } from "./db.js";

async function main() {
  console.log("Conectando a PostgreSQL...");
  await ensureSchema();
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
