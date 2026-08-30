import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/features/cognitive/persistence/postgres/schema/index.ts",
  out: "./drizzle",
});
