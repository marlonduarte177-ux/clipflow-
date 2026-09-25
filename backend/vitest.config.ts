import { defineConfig } from "vitest/config";

export default defineConfig({
  // Los tests usan una base de datos real compartida: se ejecutan de a un archivo.
  test: { fileParallelism: false, include: ["src/**/*.test.ts"] },
});
