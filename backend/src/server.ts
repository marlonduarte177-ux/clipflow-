import { createDb } from "@clipflow/shared/db";
import { loadApiConfig } from "./config.js";
import { createCognitoEmailLookup, createCognitoVerifier } from "./auth.js";
import { buildApp } from "./app.js";

const config = loadApiConfig();
const database = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });

const app = await buildApp({
  config,
  db: database.db,
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
