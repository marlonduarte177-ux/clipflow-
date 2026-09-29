import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";

/**
 * Base de datos para tests: borra TODO el esquema y aplica las migraciones desde cero.
 * Solo acepta bases cuyo nombre termina en "_test" para no borrar datos reales por error.
 */
export async function createTestDb(): Promise<DbHandle> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Falta TEST_DATABASE_URL. Arranca PostgreSQL (docker compose up -d) y define por ejemplo\n" +
        "TEST_DATABASE_URL=postgres://clipflow:clipflow_local@localhost:5432/clipflow_test",
    );
  }
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Por seguridad, la base de tests debe terminar en "_test" (recibido: "${dbName}")`);
  }
  const handle = createDb(url, { maxConnections: 5 });
  await handle.db.execute(sql`drop schema if exists public cascade`);
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  await handle.db.execute(sql`create schema public`);
  await runMigrations(handle.db);
  return handle;
}
