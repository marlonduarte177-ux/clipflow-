import { defineConfig } from "vitest/config";

export default defineConfig({
  // Sintetizar stacks (y calcular el hash de las imágenes Docker) puede tardar varios segundos.
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 180_000 },
});
