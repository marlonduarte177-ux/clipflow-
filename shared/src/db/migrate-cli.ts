/** Uso: npm run db:migrate -w @clipflow/shared  (lee DATABASE_URL). */
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL (ver .env.example)");
  process.exit(1);
}
const { db, close } = createDb(url, { maxConnections: 1, ssl: process.env.DATABASE_SSL === "true" });
try {
  await runMigrations(db);
  console.log("Migraciones aplicadas.");
} finally {
  await close();
}
