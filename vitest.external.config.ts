import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.external.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
