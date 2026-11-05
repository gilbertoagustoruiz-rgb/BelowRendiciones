import fs from "node:fs";
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

/**
 * TLS for managed PostgreSQL. With DATABASE_CA_CERT (PEM text) or DATABASE_CA_CERT_PATH
 * the server certificate is verified. Without it the connection is still encrypted but
 * not verified, and a warning is logged so it is not forgotten in production.
 */
function sslConfig() {
  let ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  if (!ca && process.env.DATABASE_CA_CERT_PATH) ca = fs.readFileSync(process.env.DATABASE_CA_CERT_PATH, "utf8");
  if (ca) return { ca, rejectUnauthorized: true };
  if (process.env.NODE_ENV === "production") {
    console.warn("[seguridad] DATABASE_CA_CERT no está configurado: la conexión a PostgreSQL está cifrada pero sin verificar el certificado.");
  }
  return { rejectUnauthorized: false };
}

export function buildDatabaseConfig(raw = process.env.DATABASE_URL) {
  const limits = {
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 30_000),
    application_name: "below-rendiciones",
  };
  if (!raw) return { connectionString: undefined, ssl: false, ...limits };

  const url = new URL(raw);
  if (["localhost", "127.0.0.1", "::1", "db", "postgres"].includes(url.hostname)) {
    return { connectionString: raw, ssl: false, ...limits };
  }

  // node-postgres lets sslmode from the URL override the ssl object, so remove it.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  return { connectionString: url.toString(), ssl: sslConfig(), ...limits };
}

export let pool = new Pool(buildDatabaseConfig());
pool.on?.("error", (error) => console.error("[db] Error en conexión inactiva:", error.message));

/** Used by tests to run the real app against an embedded PostgreSQL. */
export function setPool(next) {
  pool = next;
}

export async function query(text, params = []) {
  return pool.query(text, params);
}
