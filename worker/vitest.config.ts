import { defineConfig } from "vitest/config";

export default defineConfig({
  // Usa PostgreSQL real y FFmpeg real: de a un archivo, con tiempo suficiente.
  test: { fileParallelism: false, include: ["src/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
