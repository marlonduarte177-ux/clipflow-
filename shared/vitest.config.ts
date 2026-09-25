import { defineConfig } from "vitest/config";

export default defineConfig({
  // Los tests de base de datos comparten una base: se ejecutan de a un archivo.
  test: { fileParallelism: false, include: ["src/**/*.test.ts"] },
});
