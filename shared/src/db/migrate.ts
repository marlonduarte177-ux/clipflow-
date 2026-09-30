import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

/** Carpeta de migraciones SQL (versionadas en Git). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Número arbitrario y fijo que identifica el candado de migraciones. */
const MIGRATION_LOCK_ID = 727_001;

/**
 * Aplica las migraciones pendientes. Es seguro ejecutarlo varias veces y desde varios
 * servidores a la vez: un candado de PostgreSQL hace que solo uno migre y los demás esperen.
 */
export async function runMigrations(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`);
    await migrate(tx as unknown as Database, { migrationsFolder: MIGRATIONS_DIR });
  });
}
