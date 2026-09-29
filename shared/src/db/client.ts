import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
/** Transacción abierta con `db.transaction(...)`. */
export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Cualquier cosa que puede ejecutar consultas: la conexión o una transacción. */
export type DbExecutor = Database | DbTransaction;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * Crea la conexión a PostgreSQL.
 * - Local: DATABASE_URL de tu .env (Postgres en Docker).
 * - AWS: la URL se arma con la contraseña de Secrets Manager (se añade al desplegar RDS)
 *   y exige TLS.
 */
export function createDb(connectionString: string, options: { maxConnections?: number; ssl?: boolean } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    // Evita consultas colgadas indefinidamente.
    statement_timeout: 30_000,
  });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}
