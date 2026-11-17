import postgres from "postgres";
import { migrate } from "../src/db/migrate.js";

/** Rebuilds the test database from the migrations, once per run. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_MIGRATOR_URL!;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  } finally {
    await sql.end();
  }
  await migrate(url);
}
