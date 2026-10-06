import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : process.env.DATABASE_URL
      ? { rejectUnauthorized: false }
      : false,
});

export async function query(text, params = []) {
  return pool.query(text, params);
}
