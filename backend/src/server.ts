import { loadProductConfig } from "@clipflow/shared";
import { createDb, databaseUrlFromEnv, runMigrations } from "@clipflow/shared/db";
import { loadApiConfig } from "./config.js";
import { createCognitoEmailLookup, createCognitoVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { createSqsQueue } from "./queue.js";
import { createS3Storage } from "./storage.js";

const config = loadApiConfig();
const product = loadProductConfig();
const database = createDb(databaseUrlFromEnv(), { ssl: config.DATABASE_SSL });

// Aplica migraciones pendientes al arrancar (con candado: seguro con varias instancias).
if (process.env.RUN_MIGRATIONS_ON_START === "true") {
  await runMigrations(database.db);
}

const app = await buildApp({
  config,
  db: database.db,
  storage: createS3Storage({ bucket: config.S3_BUCKET, region: config.AWS_REGION }),
  queue: createSqsQueue({ queueUrl: config.SQS_QUEUE_URL, region: config.AWS_REGION }),
  product,
  verifyToken: createCognitoVerifier(config.COGNITO_USER_POOL_ID, config.COGNITO_CLIENT_ID),
  lookupEmail: createCognitoEmailLookup(config.AWS_REGION),
});
app.addHook("onClose", () => database.close());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "cerrando API");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.API_PORT });
