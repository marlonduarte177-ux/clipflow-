import { defineConfig } from "drizzle-kit";

// Solo se usa para GENERAR migraciones a partir de src/db/schema.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://clipflow:clipflow_local@localhost:5432/clipflow" },
  strict: true,
});
