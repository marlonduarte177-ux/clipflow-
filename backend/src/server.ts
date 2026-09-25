import { loadApiConfig } from "./config.js";
import { createCognitoVerifier } from "./auth.js";
import { buildApp } from "./app.js";

const config = loadApiConfig();
const app = await buildApp({
  config,
  verifyToken: createCognitoVerifier(config.COGNITO_USER_POOL_ID, config.COGNITO_CLIENT_ID),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "cerrando API");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.API_PORT });
