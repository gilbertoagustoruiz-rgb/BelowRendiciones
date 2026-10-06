import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

function buildDatabaseConfig() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return { connectionString: undefined, ssl: false };

  const isLocal = raw.includes("localhost") || raw.includes("127.0.0.1");
  if (isLocal) {
    return { connectionString: raw, ssl: false };
  }

  const url = new URL(raw);

  // node-postgres may let sslmode from the URL override the explicit ssl object.
  // Remove SSL query parameters and enforce encrypted transport here.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(key);
  }

  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  };
}

export const pool = new Pool(buildDatabaseConfig());

export async function query(text, params = []) {
  return pool.query(text, params);
}
