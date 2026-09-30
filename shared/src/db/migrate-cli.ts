/** Uso: npm run db:migrate -w @clipflow/shared  (lee DATABASE_URL o DB_*). */
import { createDb } from "./client.js";
import { databaseUrlFromEnv } from "./connection-url.js";
import { runMigrations } from "./migrate.js";

const { db, close } = createDb(databaseUrlFromEnv(), {
  maxConnections: 1,
  ssl: process.env.DATABASE_SSL === "true",
});
try {
  await runMigrations(db);
  console.log("Migraciones aplicadas.");
} finally {
  await close();
}
